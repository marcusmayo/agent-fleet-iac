'use strict';
// Decommission — the reverse of `up`. Discovers every surface an agent occupies
// (Cloudflare tunnel/DNS/app/token, Azure RG, Aegis registry, local contract file)
// and, with --go, tears them down in a safe order. Plan (no --go) is READ-ONLY.
//
// Teardown order matters:
//   1 Aegis deregister + 2 local file : local/safe, do first.
//   3 Azure RG delete (blocking)      : kills the VM + cloudflared connector so the
//                                       tunnel has no live connections to block on.
//   4 Access app delete               : removes its Service-Auth policy, freeing the
//                                       service token (delete-while-referenced 400s).
//   5 service token  6 DNS  7 tunnel  : now unreferenced / connector dead.

const fs = require('node:fs');
const { c, runCapture } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const cf = require('./cfapi');
const cfg = require('./aegisconfig');
const { runDeregister } = require('./register');

const env = (n) => (process.env[n] || '').trim();

async function discover(file, d, accountId, cfToken, aegisConfig) {
  const name = d.register.name;
  const fqdn = d.cloudflare.fqdn;
  const domain = fqdn.slice(fqdn.indexOf('.') + 1); // everything after the first label
  const s = { name, fqdn, rgName: d.azure.resourceGroup };

  try {
    s.tunnel = await cf.findTunnelByName(accountId, name, cfToken);
    s.token = await cf.findServiceTokenByName(accountId, `aegis-${name}`, cfToken);
    s.app = await cf.findAppByHostname(accountId, fqdn, cfToken);
    s.zoneId = await cf.findZoneIdByName(domain, cfToken);
    s.dns = s.zoneId ? await cf.findDnsRecordByHostname(s.zoneId, fqdn, cfToken) : null;
  } catch (e) {
    s.cfErr = e.message;
  }

  const rg = runCapture('az', ['group', 'exists', '-n', s.rgName]);
  s.rg = String(rg.stdout || '').trim() === 'true';

  try {
    const conf = aegisConfig && fs.existsSync(aegisConfig) ? cfg.load(aegisConfig) : null;
    s.aegis = !!(conf && (conf.agents || []).some((a) => a.name === name));
  } catch { s.aegis = false; }

  s.localFile = fs.existsSync(file) ? file : null;
  return s;
}

function printPlan(s) {
  const del = (extra) => c.yellow('DELETE') + (extra ? c.dim('  ' + extra) : '');
  const gone = (extra) => c.dim((extra ? extra + ' — ' : '') + 'absent');
  console.log(c.bold(`\nTeardown plan for "${s.name}"  (surfaces present are DELETE; absent are skipped)`));
  console.log(`  1 Aegis registry     ${s.aegis ? c.yellow('DEREGISTER') : c.dim('not registered')}`);
  console.log(`  2 local config       ${s.localFile ? del(s.localFile) : gone()}`);
  console.log(`  3 Azure RG           ${s.rg ? del(s.rgName) : gone(s.rgName)}`);
  console.log(`  4 CF Access app      ${s.app ? del(s.app.id) : gone()}`);
  console.log(`  5 CF service token   ${s.token ? del(s.token.id) : gone('aegis-' + s.name)}`);
  console.log(`  6 CF DNS (CNAME)     ${s.dns ? del(s.fqdn) : gone(s.fqdn)}`);
  console.log(`  7 CF tunnel          ${s.tunnel ? del(s.tunnel.id) : gone(s.name)}`);
  if (s.cfErr) console.log(c.red(`  ! Cloudflare query error (CF surfaces may be incomplete): ${s.cfErr}`));
}

async function execute(file, d, accountId, cfToken, aegisConfig, s) {
  const ok = (m) => console.log(c.green(`  ✓ ${m}`));
  const skip = (m) => console.log(c.dim(`  – ${m} (already gone)`));
  const fail = (m, e) => console.log(c.red(`  ✗ ${m}: ${e && e.message ? e.message : e}`));

  // 1. Aegis registry (local, safe first — reuses deregister; file still on disk here)
  if (s.aegis) { try { runDeregister(file, { aegisConfig }); ok('Aegis: deregistered'); } catch (e) { fail('Aegis deregister', e); } }
  else skip('Aegis registry');

  // 2. local contract file
  if (s.localFile) { try { fs.unlinkSync(s.localFile); ok(`local config: deleted ${s.localFile}`); } catch (e) { fail('local config delete', e); } }
  else skip('local config');

  // 3. Azure RG (blocking so the connector dies before the tunnel delete)
  if (s.rg) {
    console.log(c.dim(`  … deleting ${d.azure.resourceGroup} (blocking; a few minutes) …`));
    const r = runCapture('az', ['group', 'delete', '-n', d.azure.resourceGroup, '--yes']);
    if (r.status === 0) ok(`Azure RG: deleted ${d.azure.resourceGroup}`);
    else fail('Azure RG delete', new Error(String(r.stderr || '').trim() || `az exit ${r.status}`));
  } else skip(`Azure RG ${d.azure.resourceGroup}`);

  // 4. CF Access app (removes its policies -> frees the service token)
  if (s.app) { try { await cf.deleteApp(accountId, s.app.id, cfToken); ok('CF Access app: deleted'); } catch (e) { fail('CF Access app delete', e); } }
  else skip('CF Access app');

  // 5. CF service token (now unreferenced)
  if (s.token) { try { await cf.deleteServiceToken(accountId, s.token.id, cfToken); ok('CF service token: deleted'); } catch (e) { fail('CF service token delete', e); } }
  else skip('CF service token');

  // 6. CF DNS CNAME
  if (s.dns && s.zoneId) { try { await cf.deleteDnsRecord(s.zoneId, s.dns.id, cfToken); ok('CF DNS CNAME: deleted'); } catch (e) { fail('CF DNS delete', e); } }
  else skip('CF DNS CNAME');

  // 7. CF tunnel (connector dead after the RG delete)
  if (s.tunnel) { try { await cf.deleteTunnel(accountId, s.tunnel.id, cfToken); ok('CF tunnel: deleted'); } catch (e) { fail('CF tunnel delete', e); } }
  else skip('CF tunnel');
}

async function runDecommission(file, opts = {}) {
  const accountId = env('CF_ACCOUNT_ID');
  const cfToken = env('CF_API_TOKEN');
  if (!accountId || !cfToken) {
    console.error(c.red('decommission: set CF_ACCOUNT_ID and CF_API_TOKEN (the same token used for up) so CF surfaces can be discovered/deleted.'));
    return 2;
  }
  const res = loadContract(file);
  if (!res.ok) { console.error(c.red(`decommission: ${(res.errors || []).join('; ')}`)); return 2; }
  const v = res.value;
  const d = derive(v);

  const aegisPath = opts.aegisConfig || env('AEGIS_CONFIG'); // up finds it via the env var too
  console.log(c.bold(`\nDecommission "${d.register.name}" (${d.azure.profile}) at ${d.cloudflare.fqdn}`));
  const s = await discover(file, d, accountId, cfToken, aegisPath);
  printPlan(s);

  const anything = s.aegis || s.localFile || s.rg || s.app || s.token || s.dns || s.tunnel;
  if (!anything) { console.log(c.green('\nNothing to decommission — every surface is already absent.')); return 0; }

  if (!opts.go) {
    console.log(c.dim('\nPlan only — nothing deleted. Re-run with --go to execute the teardown above.'));
    return 0;
  }

  console.log(c.red(`\n--go: DESTRUCTIVE — deleting every DELETE surface above for "${d.register.name}".`));
  await execute(file, d, accountId, cfToken, aegisPath, s);
  console.log(c.green(`\ndecommission ${d.register.name} complete. Restart Aegis (node aegis.js) so the console drops it.`));
  return 0;
}

module.exports = { runDecommission, discover, printPlan };

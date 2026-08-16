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
    // Legacy hand-built agents (pre-fleetctl) also carried an ssh-<name> tunnel hostname
    // (+ sometimes an Access app on it). Modern `up` builds are tunnel-only and never create
    // these, so this discovery is a no-op for fleet-provisioned agents -- but sweeping them
    // here means ONE decommission run leaves zero Cloudflare residue either way.
    s.sshFqdn = 'ssh-' + name + '.' + domain;
    s.appSsh = await cf.findAppByHostname(accountId, s.sshFqdn, cfToken);
    s.dnsSsh = s.zoneId ? await cf.findDnsRecordByHostname(s.zoneId, s.sshFqdn, cfToken) : null;
    // Legacy account-level REUSABLE policies (hand-built era): fleetctl-provisioned apps use
    // INLINE policies that die with the app, but the original agents' reusable policies
    // survive app deletion and keep the service token "in use" (CF 12139). Sweep any that
    // reference this agent's token, plus the agent's <name>-operator allow policy.
    s.policies = [];
    try {
      const all = await cf.listReusablePolicies(accountId, cfToken);
      s.policies = (all || []).filter((p) => (s.token && JSON.stringify(p).includes(s.token.id)) || p.name === name + '-operator');
    } catch { /* older accounts / perms: skip quietly */ }
  } catch (e) {
    s.cfErr = e.message;
  }

  const rg = runCapture('az', ['group', 'exists', '-n', s.rgName]);
  s.rg = String(rg.stdout || '').trim() === 'true';

  // Locks on the RG. The protection mirror is one CanNotDelete lock named fleet-protect: when
  // policy says the agent is NOT protected but that lock is still there, it is an orphan of a
  // failed unprotect sync (seen live: an unprotect ledgered ok with syncOutcome AuthorizationFailed
  // left the lock behind, and the RG delete was refused with ScopeLocked while every Cloudflare
  // surface was already gone). Read them here so the plan says so, and --go reconciles the
  // mirror -- policy is the source of truth -- before the RG delete. A lock with any other name
  // is somebody else's decision and refuses the teardown instead.
  s.locks = [];
  if (s.rg) {
    try { const lk = runCapture('az', ['lock', 'list', '-g', s.rgName, '-o', 'json']); const arr = lk.ok ? JSON.parse(lk.stdout || '[]') : []; s.locks = (arr || []).map((l) => ({ name: l.name, level: l.level })).filter((l) => l.name); }
    catch { s.locks = []; }
  }

  // The agent's Key Vault. Its name is deterministic per agent (<name>-kv-<hash>) and soft-delete
  // holds the name for 7 days after the RG goes, so a same-name re-provision (region move,
  // rebuild) collides with a shell that no longer serves anything. Discover it live in the RG
  // (to be soft-deleted by the RG delete) or already soft-deleted (a previous teardown), and
  // PURGE it as the last Azure surface -- purge protection is off by design for exactly this.
  s.vault = null; s.deletedVault = null;
  try {
    if (s.rg) {
      const kv = runCapture('az', ['keyvault', 'list', '-g', s.rgName, '-o', 'json']);
      const list = kv.ok ? JSON.parse(kv.stdout || '[]') : [];
      const hit = (list || []).find((v) => v && typeof v.name === 'string' && v.name.startsWith(name + '-kv-'));
      if (hit) s.vault = { name: hit.name, location: hit.location };
    }
    const dl = runCapture('az', ['keyvault', 'list-deleted', '-o', 'json']);
    const dead = dl.ok ? JSON.parse(dl.stdout || '[]') : [];
    const gone = (dead || []).find((v) => v && typeof v.name === 'string' && v.name.startsWith(name + '-kv-'));
    if (gone) s.deletedVault = { name: gone.name, location: (gone.properties && gone.properties.location) || gone.location || '' };
  } catch { /* unreadable -> not listed; RG delete still proceeds */ }

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
  const vaultLine = s.vault
    ? del(s.vault.name + ' — soft-deleted by the RG delete, then PURGED so the name is free for a same-name re-provision')
    : s.deletedVault ? del(s.deletedVault.name + ' — already soft-deleted; PURGE') : gone('vault');
  console.log(`  8. Key Vault (purge)     ${vaultLine}`);
  for (const l of (s.locks || [])) {
    const ours = l.name === 'fleet-protect';
    console.log('  !  RG lock              ' + (ours ? c.yellow(l.name + ' (' + l.level + ') — orphan of a failed unprotect sync; --go removes it before the RG delete') : c.red(l.name + ' (' + l.level + ') — NOT the fleet mirror; the RG delete will be refused until it is removed by whoever set it')));
  }
  console.log(c.bold(`\nTeardown plan for "${s.name}"  (surfaces present are DELETE; absent are skipped)`));
  console.log(`  1 Aegis registry     ${s.aegis ? c.yellow('DEREGISTER') : c.dim('not registered')}`);
  console.log(`  2 local config       ${s.localFile ? del(s.localFile) : gone()}`);
  console.log(`  3 Azure RG           ${s.rg ? del(s.rgName) : gone(s.rgName)}`);
  console.log(`  4 CF Access app      ${s.app ? del(s.app.id) : gone()}`);
  console.log(`  5 CF service token   ${s.token ? del(s.token.id) : gone('aegis-' + s.name)}`);
  console.log(`  6 CF DNS (CNAME)     ${s.dns ? del(s.fqdn) : gone(s.fqdn)}`);
  console.log(`  7 CF tunnel          ${s.tunnel ? del(s.tunnel.id) : gone(s.name)}`);
  if (s.appSsh || s.dnsSsh || (s.policies && s.policies.length)) {
    console.log(c.dim('  legacy leftovers (hand-built era):'));
    if (s.appSsh) console.log(`  +  CF Access app     ${del(s.sshFqdn)}`);
    if (s.dnsSsh) console.log(`  +  CF DNS (ssh)      ${del(s.sshFqdn)}`);
    for (const p of (s.policies || [])) console.log(`  +  CF reusable policy ${del(`"${p.name}" ${p.id}`)}`);
  }
  if (s.cfErr) console.log(c.red(`  ! Cloudflare query error (CF surfaces may be incomplete): ${s.cfErr}`));
}

async function execute(file, d, accountId, cfToken, aegisConfig, s) {
  const failures = [];
  const ok = (m) => console.log(c.green(`  ✓ ${m}`));
  const skip = (m) => console.log(c.dim(`  – ${m} (already gone)`));
  const fail = (m, e) => { failures.push(m); console.log(c.red(`  ✗ ${m}: ${e && e.message ? e.message : e}`)); };

  // 1. Aegis registry (local, safe first — reuses deregister; file still on disk here)
  if (s.aegis) { try { runDeregister(file, { aegisConfig }); ok('Aegis: deregistered'); } catch (e) { fail('Aegis deregister', e); } }
  else skip('Aegis registry');

  // 2. local contract file
  if (s.localFile) { try { fs.unlinkSync(s.localFile); ok(`local config: deleted ${s.localFile}`); } catch (e) { fail('local config delete', e); } }
  else skip('local config');

  // 3. Azure RG (blocking so the connector dies before the tunnel delete)
  let rgGone = !s.rg;
  if (s.rg) {
    const foreign = (s.locks || []).filter((l) => l.name !== 'fleet-protect');
    const mirror = (s.locks || []).filter((l) => l.name === 'fleet-protect');
    if (foreign.length) {
      fail('Azure RG delete', new Error('refused: lock(s) not set by the fleet: ' + foreign.map((l) => l.name + ' (' + l.level + ')').join(', ') + ' — remove them first (az lock delete) or leave the RG'));
    } else {
      for (const l of mirror) {
        // policy already said "not protected" (the gate above), so this lock is an orphan mirror
        const lr = runCapture('az', ['lock', 'delete', '--name', l.name, '-g', d.azure.resourceGroup]);
        if (lr.status === 0) ok(`Azure RG lock: removed orphan mirror ${l.name} (policy says not protected)`);
        else fail(`Azure RG lock delete (${l.name})`, new Error(String(lr.stderr || '').trim() || `az exit ${lr.status}`));
      }
      console.log(c.dim(`  … deleting ${d.azure.resourceGroup} (blocking; a few minutes) …`));
      const r = runCapture('az', ['group', 'delete', '-n', d.azure.resourceGroup, '--yes']);
      if (r.status === 0) { rgGone = true; ok(`Azure RG: deleted ${d.azure.resourceGroup}`); }
      else fail('Azure RG delete', new Error(String(r.stderr || '').trim() || `az exit ${r.status}`));
    }
  } else skip(`Azure RG ${d.azure.resourceGroup}`);

  // 3b. Purge the soft-deleted vault so its deterministic name is free again. Purge is
  // irreversible for the vault's secrets -- they were the agent's own API keys, re-seeded on any
  // re-provision, and this runs inside an already-attested destructive teardown.
  const purgeName = (s.vault && s.vault.name) || (s.deletedVault && s.deletedVault.name) || '';
  const purgeLoc = (s.vault && s.vault.location) || (s.deletedVault && s.deletedVault.location) || d.azure.region || '';
  // a vault that is still live in an RG that did NOT go has nothing to purge yet
  if (purgeName && (rgGone || s.deletedVault)) {
    let purged = false, lastErr = '';
    // the RG delete is blocking, but the deleted-vault record can lag a few seconds
    for (let i = 0; i < 6 && !purged; i++) {
      const pr = runCapture('az', ['keyvault', 'purge', '--name', purgeName, ...(purgeLoc ? ['--location', purgeLoc] : []), '-o', 'none']);
      if (pr.status === 0) purged = true;
      else { lastErr = String(pr.stderr || '').split('\n')[0]; if (/not found|NotFound|does not exist/i.test(lastErr)) { await new Promise((r) => setTimeout(r, 5000)); } else break; }
    }
    if (purged) ok(`Key Vault: purged soft-deleted ${purgeName} (name free for re-provision)`);
    else fail('Key Vault purge', new Error(lastErr || 'purge failed'));
  } else skip('Key Vault purge');

  // 4. CF Access app (removes its policies -> frees the service token)
  if (s.app) { try { await cf.deleteApp(accountId, s.app.id, cfToken); ok('CF Access app: deleted'); } catch (e) { fail('CF Access app delete', e); } }
  else skip('CF Access app');
  if (s.appSsh) { try { await cf.deleteApp(accountId, s.appSsh.id, cfToken); ok('CF Access app (ssh, legacy): deleted'); } catch (e) { fail('CF Access app (ssh) delete', e); } }
  for (const p of (s.policies || [])) {
    try { await cf.deleteReusablePolicy(accountId, p.id, cfToken); ok(`CF reusable policy (legacy): deleted "${p.name}"`); }
    catch (e) { fail(`CF reusable policy delete ("${p.name}")`, e); }
  }

  // 5. CF service token (now unreferenced). CF can return 12139 (token in use) if the
  // just-deleted app's Service-Auth policy hasn't propagated yet -- retry with backoff.
  // A 12139 that survives the retries means a legacy standalone policy/group still
  // references it (hand-built era): remove that reference in the CF dashboard, re-run.
  if (s.token) {
    let done = false, lastErr = null;
    for (let i = 0; i < 3 && !done; i++) {
      if (i) await new Promise((r) => setTimeout(r, 4000));
      try {
        await cf.deleteServiceToken(accountId, s.token.id, cfToken);
        done = true; ok('CF service token: deleted' + (i ? ` (retry ${i})` : ''));
      } catch (e) { lastErr = e; }
    }
    if (!done) fail('CF service token delete (after retries — a legacy policy/group may still reference it; remove it in the CF dashboard, then re-run)', lastErr);
  }
  else skip('CF service token');

  // 6. CF DNS CNAME
  if (s.dns && s.zoneId) { try { await cf.deleteDnsRecord(s.zoneId, s.dns.id, cfToken); ok('CF DNS CNAME: deleted'); } catch (e) { fail('CF DNS delete', e); } }
  else skip('CF DNS CNAME');
  if (s.dnsSsh && s.zoneId) { try { await cf.deleteDnsRecord(s.zoneId, s.dnsSsh.id, cfToken); ok('CF DNS (ssh-' + s.name + ', legacy): deleted'); } catch (e) { fail('CF DNS (ssh) delete', e); } }

  // 7. CF tunnel (connector dead after the RG delete)
  if (s.tunnel) { try { await cf.deleteTunnel(accountId, s.tunnel.id, cfToken); ok('CF tunnel: deleted'); } catch (e) { fail('CF tunnel delete', e); } }
  else skip('CF tunnel');
  return failures;
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
  // Protection gate (Can't layer): a protected agent REFUSES teardown before any
  // discovery or deletion. Unprotect first via the attested policy ceremony.
  {
    let prot;
    try { prot = (require('./policy').loadPolicy() || {}).protectedAgents || []; }
    catch (e) { prot = null; }
    if (opts.go && prot === null) {
      console.error(c.red('decommission REFUSED — cannot read aegis.policy.jsonc to verify protection (fail-closed). Fix the policy file first.'));
      return 3;
    }
    if (Array.isArray(prot) && prot.includes(d.register.name)) {
      if (!opts.go) {
        console.log(c.yellow(`\nPROTECTED — "${d.register.name}" is in policy protectedAgents; --go will REFUSE until it is removed.`));
      } else {
        console.error(c.red(`\ndecommission REFUSED — "${d.register.name}" is protected by policy (protectedAgents).`));
        console.error(c.yellow('  To proceed, first run the attested unprotect ceremony:'));
        console.error(c.yellow(`    fleetctl policy unprotect ${d.register.name} --attest "I approve unprotecting ${d.register.name}"`));
        console.error(c.dim('  (that set also removes the Azure CanNotDelete lock on rg-' + d.register.name + ')'));
        return 3;
      }
    }
  }
  console.log(c.bold(`\nDecommission "${d.register.name}" (${d.azure.profile}) at ${d.cloudflare.fqdn}`));
  const s = await discover(file, d, accountId, cfToken, aegisPath);
  printPlan(s);

  const anything = s.aegis || s.localFile || s.rg || s.app || s.token || s.dns || s.tunnel || s.appSsh || s.dnsSsh || (s.policies && s.policies.length);
  if (!anything) { console.log(c.green('\nNothing to decommission — every surface is already absent.')); return 0; }

  if (!opts.go) {
    console.log(c.dim('\nPlan only — nothing deleted.'));
    console.log(c.yellow('  To EXECUTE (DESTRUCTIVE — deletes every DELETE surface above): re-run the SAME command'));
    console.log(c.yellow('  with the --go flag appended at the end, e.g.  fleetctl decommission ' + file + ' --go'));
    console.log(c.dim('  (--go is a flag; the agent is the contract file above, not a word typed after --go.)'));
    return 0;
  }

  console.log(c.red(`\n--go: DESTRUCTIVE — deleting every DELETE surface above for "${d.register.name}".`));
  // Surface 0: bank a final snapshot into the fleet backup store (best-effort,
  // never blocks -- the store outlives the agent, so this IS the undo button).
  require('./backup').finalSnapshot(d.register.name);
  const failures = await execute(file, d, accountId, cfToken, aegisPath, s);
  if (failures && failures.length) {
    // A teardown that could not finish must not read as finished: the panel and the ledger both
    // key off this line, and "complete" over a locked RG left a VM running with no front door.
    console.log(c.red(`\ndecommission ${d.register.name} INCOMPLETE — ${failures.length} surface(s) failed: ${failures.join('; ')}. Re-run after fixing; every surface is idempotent.`));
    return 1;
  }
  console.log(c.green(`\ndecommission ${d.register.name} complete. Refresh fleet in Aegis to drop the card (deregister already updated the config).`));
  return 0;
}

module.exports = { runDecommission, discover, printPlan };

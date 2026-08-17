'use strict';
const https = require('node:https');
const { c, findFleetRoot } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const cfg = require('./aegisconfig');

// GET https://<host>/health/liveliness with the Cloudflare Access service-token
// headers. Never throws; resolves { ok, status, body } or { ok:false, error }.
function probe(host, clientId, clientSecret) {
  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET',
      hostname: host,
      path: '/health/liveliness',
      timeout: 15000,
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      },
    }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; if (body.length > 4000) req.destroy(); });
      r.on('end', () => resolve({ ok: true, status: r.statusCode, body: body.slice(0, 300) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout after 15s' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

async function runCheckLive(file, opts = {}) {
  console.log(c.cyan(`check --live  ${file}`));
  const res = loadContract(file);
  if (!res.ok) {
    console.log(c.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  const v = res.value;
  const d = derive(v);
  console.log(c.dim(`  probe: https://${d.cloudflare.fqdn}/health/liveliness  (via Cloudflare Access service token)`));

  const skip = (why) => {
    console.log(c.yellow(`\nSKIPPED live probe: ${why}`));
    return opts.requireLive ? 2 : 0;
  };

  const { path: configPath, exists } = cfg.resolveConfigPath(opts.aegisConfig, findFleetRoot());
  if (!configPath || !exists) return skip('aegis.config.json not found — register the agent first (or set $AEGIS_CONFIG)');

  let data;
  try { data = cfg.load(configPath); }
  catch (e) { console.log(c.red('\n' + e.message)); return 1; }

  const agent = data.agents.find((a) => a && a.name === v.name);
  if (!agent) return skip(`"${v.name}" is not registered in aegis.config.json (run register first)`);
  if (!agent.clientId || !agent.clientSecret) return skip(`"${v.name}" has no service-token credentials in the config`);

  console.log(c.bold('\nProbing…'));
  const r = await probe(d.cloudflare.fqdn, agent.clientId, agent.clientSecret);
  if (!r.ok) {
    console.log(c.red(`\nlive probe FAILED: ${r.error}`));
    console.log(c.dim('  Is the VM running (az vm start)? tunnel up? token valid?'));
    return 1;
  }
  if (r.status === 200) {
    console.log(c.green(`\ncheck --live OK — ${d.cloudflare.fqdn} returned HTTP 200 (agent healthy).`));
    return 0;
  }
  console.log(c.red(`\ncheck --live: HTTP ${r.status} (expected 200).`));
  if (r.status === 403) console.log(c.dim('  403 = Cloudflare Access rejected the token — verify the Service Auth policy and token validity.'));
  if (r.status === 502 || r.status === 530) console.log(c.dim(`  ${r.status} = tunnel reachable, webchat not answering yet — still building or waiting for its seed; re-run in a few minutes.`));
  const snippet = r.body.replace(/\s+/g, ' ').trim();
  if (snippet) console.log(c.dim('  body: ' + snippet));
  return 1;
}

module.exports = { runCheckLive };

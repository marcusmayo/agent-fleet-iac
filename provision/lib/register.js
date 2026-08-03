'use strict';
const { c, findFleetRoot } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const cfg = require('./aegisconfig');

// Append/update the agent's entry in aegis.config.json. Credentials come from `up`
// in-process, or from env for standalone use — NEVER from CLI flags (which would
// leak the secret into shell history). The secret is written to the (gitignored)
// config and is never printed.
function runRegister(file, opts = {}) {
  console.log(c.cyan(`register  ${file}`));
  const res = loadContract(file);
  if (!res.ok) {
    console.log(c.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  const v = res.value;
  const d = derive(v);

  const clientId = opts.clientId || process.env.AEGIS_CLIENT_ID || '';
  const clientSecret = opts.clientSecret || process.env.AEGIS_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    console.log(c.red('\nregister: missing service-token credentials.'));
    console.log('  Set $AEGIS_CLIENT_ID + $AEGIS_CLIENT_SECRET, or run `up` (which mints the token and registers automatically).');
    return 2;
  }

  const { path: configPath } = cfg.resolveConfigPath(opts.aegisConfig, findFleetRoot());
  if (!configPath) {
    console.log(c.red('\nregister: could not resolve aegis.config.json — set $AEGIS_CONFIG or pass --aegis-config <path>.'));
    return 2;
  }
  console.log(c.dim(`  config: ${configPath}`));

  // Fail closed: refuse to write the secret into a trackable, non-ignored file.
  const gi = cfg.gitignoreState(configPath);
  if (gi.state === 'not-ignored') {
    console.log(c.red(`\nREFUSING to write — ${gi.detail}.`));
    console.log('  aegis.config.json holds the service-token secret; add it to .gitignore first.');
    return 1;
  }
  if (gi.state === 'no-repo') console.log(c.yellow(`  warn: ${gi.detail} — make sure it is never committed anywhere.`));
  if (gi.state === 'no-git') console.log(c.yellow('  warn: git not found — cannot verify gitignore; make sure the config is never committed.'));

  let data;
  try { data = cfg.load(configPath); }
  catch (e) { console.log(c.red('\n' + e.message)); return 1; }

  const entry = { name: v.name, profile: v.profile, host: d.cloudflare.fqdn, clientId, clientSecret };
  const action = cfg.upsertAgent(data, entry);
  cfg.save(configPath, data);

  console.log(c.green(`\nregister OK — ${action} agent "${v.name}".`));
  console.log(`  host          ${entry.host}`);
  console.log(`  profile       ${entry.profile}`);
  console.log(`  clientId      ${entry.clientId}`);
  console.log(`  clientSecret  ${c.dim(`written to config (${clientSecret.length} chars, not shown)`)}`);
  console.log(c.dim(`  agents now registered: ${data.agents.map((a) => a.name).join(', ')}`));
  return 0;
}

module.exports = { runRegister };

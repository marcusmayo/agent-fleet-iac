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

module.exports = { runRegister, runDeregister };

// Remove an agent from aegis.config.json so Aegis self-updates on decommission.
// Accepts a bare agent name OR a contract file (from which the name is read).
// Idempotent: removing an absent agent is a clear no-op. Never touches the secret
// of any other agent.
function runDeregister(nameOrFile, opts = {}) {
  const fs = require('node:fs');
  const { c, findFleetRoot } = require('./util');
  const cfg = require('./aegisconfig');

  let name = nameOrFile;
  if (typeof nameOrFile === 'string' && (nameOrFile.endsWith('.jsonc') || fs.existsSync(nameOrFile))) {
    const res = loadContract(nameOrFile);
    if (!res.ok) {
      console.log(c.red('\nContract INVALID:'));
      for (const e of res.errors) console.log('  - ' + e);
      return 1;
    }
    name = res.value.name;
  }
  console.log(c.cyan(`deregister  ${name}`));

  const { path: configPath, exists } = cfg.resolveConfigPath(opts.aegisConfig, findFleetRoot());
  if (!configPath) {
    console.log(c.red('\nderegister: could not resolve aegis.config.json — set $AEGIS_CONFIG or pass --aegis-config <path>.'));
    return 2;
  }
  if (!exists) {
    console.log(c.yellow(`\naegis.config.json not found at ${configPath} — nothing to deregister.`));
    return 0;
  }
  console.log(c.dim(`  config: ${configPath}`));

  let data;
  try { data = cfg.load(configPath); }
  catch (e) { console.log(c.red('\n' + e.message)); return 1; }

  const action = cfg.removeAgent(data, name);
  if (action === 'absent') {
    console.log(c.yellow(`\n"${name}" is not in aegis.config.json — nothing to remove.`));
    console.log(c.dim(`  registered: ${data.agents.map((a) => a.name).join(', ') || '(none)'}`));
    return 0;
  }
  cfg.save(configPath, data);
  console.log(c.green(`\nderegister OK — removed agent "${name}".`));
  console.log(c.dim(`  agents now registered: ${data.agents.map((a) => a.name).join(', ') || '(none)'}`));
  console.log(c.dim('  Aegis reflects this on the next Refresh fleet (config is re-read per request).'));
  return 0;
}

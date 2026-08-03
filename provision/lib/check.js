'use strict';
const { c, findFleetRoot } = require('./util');
const { loadContract } = require('./contract');
const pf = require('./preflight');

const glyph = { pass: c.green('PASS'), fail: c.red('FAIL'), warn: c.yellow('WARN') };
const line = (item) => console.log(`  [${glyph[item.level]}] ${c.bold(item.label)} — ${item.detail}`);

function summarize(v) {
  console.log(c.bold('\nContract'));
  console.log(`  name       ${v.name}`);
  console.log(`  profile    ${v.profile}`);
  console.log(`  domain     ${v.domain}   ->   ${v.name}.${v.domain}`);
  console.log(`  webchat    localhost:${v.webchatPort}`);
  console.log(`  region     ${v.region}`);
  console.log(`  ssh        ${v.sshCidr ? `${v.sshCidr} (public IP for temp SSH)` : 'hardened — no public IP, tunnel-only'}`);
  console.log(`  repo       ${v.repoUrl}${v.repoUrlIsDefault ? c.dim(' (profile default)') : ''} @ ${v.repoRef || 'default-branch HEAD'}`);
}

function runCheck(file, opts = {}) {
  console.log(c.cyan(`check  ${file}`));
  const res = loadContract(file);
  if (!res.ok) {
    console.log(c.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  console.log(c.green('\nContract valid.'));
  summarize(res.value);
  for (const w of res.warnings) console.log(c.yellow('  warn: ' + w));

  if (opts.contractOnly) {
    console.log(c.dim('\n(--contract-only: environment preflight skipped)'));
    return 0;
  }

  const root = findFleetRoot();
  console.log(c.bold('\nEnvironment preflight') + (root ? c.dim(`   (fleet root: ${root})`) : ''));
  if (!root) {
    console.log('  [' + glyph.fail + '] fleet root — could not locate bicep/main.bicep + scripts/deploy.sh (set $FLEET_DIR)');
    return 1;
  }

  const items = [
    pf.azAccount(),
    pf.cfApiToken(),
    pf.sshPubkey().result,
    pf.mainBicep(root),
    pf.paramFile(root, res.value.profile),
    pf.chainScripts(root),
  ];
  if (res.value.profile === 'castor') items.push(pf.deployerObjectId());
  items.forEach(line);

  const failed = items.filter((i) => i.level === pf.FAIL).length;
  const warned = items.filter((i) => i.level === pf.WARN).length;
  console.log('');
  if (failed) {
    console.log(c.red(`check FAILED — ${failed} blocking item(s), ${warned} warning(s). Resolve before plan/up.`));
    return 1;
  }
  console.log(c.green(`check OK — ready to plan${warned ? ` (${warned} warning(s))` : ''}.`));
  return 0;
}

module.exports = { runCheck };

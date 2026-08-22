'use strict';
// `up` threw `opts is not defined` while PRINTING its plan — printPlan referenced a variable it
// never received, so the command could not run at all, on either the plan or the --go path.
// Nothing was created (the throw landed before the preflight and before any API call), but an
// operator found it while provisioning a real agent, because no test ever CALLED the renderer and
// a ReferenceError inside a template literal is invisible to node --check.
//
// So the renderer is executed here with stdout captured. The state it renders is BUILT BY HAND:
// the first version of this file called gather(), which runs the repo gate (a real git clone)
// and shells out to az, and three tests turned a three-second gate into a seven-minute one. A
// gate nobody wants to run is a gate that gets skipped. What gather actually computes is checked
// against the source instead, which costs nothing and catches the same divergence.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { printPlan } = require('../lib/up');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'up.js'), 'utf8');
const V = { name: 'probe', profile: 'castor', domain: 'example.com', region: 'northcentralus', webchatPort: 8443 };
const R = {
  d: { cloudflare: { fqdn: 'probe.example.com' }, azure: { resourceGroup: 'rg-probe', vmName: 'probe-vm', repoUrl: 'https://example.com/r' } },
  cfToken: 'tok', accountId: 'acct', operatorEmail: 'op@example.com', pubkey: 'ssh-ed25519 AAAA',
  pwsh: true, bash: true, az: true, configPath: '/x/aegis.config.json', giState: 'ignored',
  repoGate: { ok: true }, tokenName: 'plane-one-probe', fleetRoot: '/x',
  // the rest of what the renderer reads: the policy block, the fleet it compares against, and
  // the capacity probe. Built here rather than gathered, so the gate stays hermetic and fast.
  pol: { maxFleet: 6, maxBatch: 2, maxMonthlyBudgetUsd: 150, budgetName: 'fleet-monthly', allowedRegions: ['northcentralus'], defaultRegion: 'northcentralus' },
  fleet: ['one', 'two'],
  capacity: { ok: true, detail: 'family quota 10, 6 used' },
};

function render(v, r) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { printPlan(v, r); } finally { console.log = orig; }
  return lines.join('\n');
}

test('up can print its own plan — the renderer executes end to end', () => {
  const out = render(V, R);                 // would throw ReferenceError before the fix
  assert.match(out, /preflight/);
  assert.match(out, /Service token/);
  assert.match(out, /Deploy the VM/);
});

test('the plan prints the token name it was GIVEN, never a second derivation', () => {
  const out = render(V, R);
  assert.ok(out.split('plane-one-probe').length - 1 >= 2, 'the token and its policy both use it');
  const other = render(V, { ...R, tokenName: 'plane-two-probe' });
  assert.match(other, /plane-two-probe/);
  assert.ok(!/plane-one-probe/.test(other), 'nothing in the renderer rebuilds the name');
});

test('gather computes that name once, and the execution reuses it', () => {
  assert.match(SRC, /tokenName: `\$\{planeName\(opts\.plane\)\}-\$\{v\.name\}`/, 'one derivation, in gather');
  assert.strictEqual(SRC.split('R.tokenName').length - 1, 3, 'two plan sites and the execution site');
  assert.strictEqual(SRC.split('planeName(opts.plane)').length - 1, 1, 'and nowhere else derives it');
});

test('the plan no longer promises a per-agent backup account for castor', () => {
  assert.ok(!/backup-account/.test(render(V, R)));
  assert.ok(!/backup-account/.test(SRC), 'that resource was removed from the template');
});

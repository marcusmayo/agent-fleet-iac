'use strict';
// `up` threw `opts is not defined` while PRINTING its plan — printPlan referenced a variable it
// never received, on both the plan and the --go path, so the command could not run at all. Nothing
// was created (the throw landed before the preflight and before any API call), but it was found by
// an operator provisioning a real agent rather than by the suite, because nothing ever CALLED the
// renderer. A ReferenceError in a template literal is invisible to node --check and to any test
// that only imports the module: the line has to execute.
//
// So this test executes it, with stdout captured. It is deliberately shallow about wording and
// strict about the two things that matter: it must not throw, and the token name it prints must
// be the same value the run later uses, because a plan that states one name while the execution
// derives another is a divergence nobody sees until the surfaces disagree.
const { test } = require('node:test');
const assert = require('node:assert');
const { gather, printPlan } = require('../lib/up');
const { loadContract } = require('../lib/contract');
const path = require('node:path');

const CONTRACT = path.resolve(__dirname, '..', '..', 'agents', 'example.agent.jsonc');

function render(v, R) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { printPlan(v, R); } finally { console.log = orig; }
  return lines.join('\n');
}

test('up can print its own plan — the renderer executes end to end', () => {
  const res = loadContract(CONTRACT);
  assert.ok(res.ok, 'the committed example contract must load');
  const R = gather(res.value, {});
  const out = render(res.value, R);          // would throw ReferenceError before the fix
  assert.match(out, /preflight/);
  assert.match(out, /Service token/);
  assert.match(out, /Deploy the VM/);
});

test('the plan and the execution share ONE token name', () => {
  const res = loadContract(CONTRACT);
  const R = gather(res.value, { plane: 'somewhere' });
  assert.ok(R.tokenName, 'gather computes the name');
  assert.match(R.tokenName, new RegExp('-' + res.value.name + '$'), 'it ends in the agent name');
  const out = render(res.value, R);
  const hits = out.split(R.tokenName).length - 1;
  assert.ok(hits >= 2, 'the plan prints that exact name for the token and its policy, not a rederivation');
});

test('the plane label reaches the name, so two planes cannot mint the same token name', () => {
  const res = loadContract(CONTRACT);
  const a = gather(res.value, { plane: 'plane-one' }).tokenName;
  const b = gather(res.value, { plane: 'plane-two' }).tokenName;
  assert.notStrictEqual(a, b);
  assert.match(a, /^plane-one-/);
});

test('the plan no longer promises a per-agent backup account for castor', () => {
  const res = loadContract(CONTRACT);
  const v = { ...res.value, profile: 'castor' };
  const out = render(v, gather(v, {}));
  assert.ok(!/backup-account/.test(out), 'that resource was removed from the template');
});

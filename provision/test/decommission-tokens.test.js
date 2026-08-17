'use strict';
// A teardown must remove every service token that granted access to the agent, whichever plane
// minted it. Live: the workstation's decommission deleted aegis-<name> and left the hosted plane's
// <plane>-<name> (created by Enroll) behind as an unreferenced credential.
const { test } = require('node:test');
const assert = require('node:assert');
const { selectAgentTokens } = require('../lib/decommission');

const T = (id, name) => ({ id, name });
const tokens = [T('t1', 'aegis-probe'), T('t2', 'aegis-vm-probe'), T('t3', 'aegis-bosun'), T('t4', 'aegis-vm-bosun'), T('t5', 'aegis-x-probe'), T('t6', 'unrelated')];
const names = (r) => r.map((t) => t.name).sort();

test('the lane\'s own aegis-<name> token is selected by name', () => {
  assert.deepStrictEqual(names(selectAgentTokens([T('t1', 'aegis-probe'), T('t3', 'aegis-bosun')], [], 'probe')), ['aegis-probe']);
});

test('a token referenced by the app\'s Service Auth policy is selected whatever it is called (the enrolled plane\'s token)', () => {
  const policies = [{ name: 'aegis-vm-probe', include: [{ service_token: { token_id: 't2' } }] }, { name: 'probe-operator', include: [{ email: { email: 'x@y' } }] }];
  assert.deepStrictEqual(names(selectAgentTokens([T('t1', 'aegis-probe'), T('t2', 'aegis-vm-probe'), T('t6', 'unrelated')], policies, 'probe')), ['aegis-probe', 'aegis-vm-probe']);
});

test('when the app is already gone, <plane>-<name> tokens are found by naming', () => {
  assert.deepStrictEqual(names(selectAgentTokens(tokens, [], 'probe', ['heimdall', 'bosun', 'probe'])), ['aegis-probe', 'aegis-vm-probe', 'aegis-x-probe']);
});

test('a token that belongs to another agent whose name ends the same way is never touched', () => {
  // agent "x-probe" is registered: aegis-x-probe is ITS token, not probe's
  assert.deepStrictEqual(names(selectAgentTokens(tokens, [], 'probe', ['heimdall', 'bosun', 'probe', 'x-probe'])), ['aegis-probe', 'aegis-vm-probe']);
  // and decommissioning x-probe takes only its own
  assert.deepStrictEqual(names(selectAgentTokens(tokens, [], 'x-probe', ['heimdall', 'bosun', 'probe', 'x-probe'])), ['aegis-x-probe']);
});

test('nothing selected when nothing matches; malformed entries ignored', () => {
  assert.deepStrictEqual(selectAgentTokens([T('t6', 'unrelated'), { id: 't7' }, null], [{ include: [{}] }], 'probe'), []);
});

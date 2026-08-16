'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { agentIdentity, decideAction, attestSentence, planeName } = require('../lib/enroll');

test('enroll identity: a fleet agent RG (app/agent/profile tags) is accepted', () => {
  const r = agentIdentity({ app: 'agent-fleet', agent: 'bosun', profile: 'keel' }, 'bosun');
  assert.deepStrictEqual(r, { ok: true, profile: 'keel' });
});
test('enroll identity: the control plane RG is refused, not enrolled', () => {
  const r = agentIdentity({ app: 'agent-fleet', role: 'control-plane', aegis: 'aegis' }, 'aegis');
  assert.strictEqual(r.ok, false); assert.match(r.why, /control plane/);
});
test('enroll identity: wrong app tag, mismatched agent tag, missing profile all refuse', () => {
  assert.strictEqual(agentIdentity({ app: 'other', agent: 'x', profile: 'keel' }, 'x').ok, false);
  assert.match(agentIdentity({ app: 'agent-fleet', agent: 'y', profile: 'keel' }, 'x').why, /tagged agent="y", expected "x"/);
  assert.match(agentIdentity({ app: 'agent-fleet', agent: 'x' }, 'x').why, /no profile tag/);
  assert.strictEqual(agentIdentity(undefined, 'x').ok, false);
});
test('enroll action: create when no token; noop when registry holds this token id; rotate otherwise', () => {
  assert.strictEqual(decideAction(null, null), 'create');
  assert.strictEqual(decideAction(null, { clientId: 'abc.access' }), 'create');
  assert.strictEqual(decideAction({ id: 't1', client_id: 'abc.access' }, { clientId: 'abc.access' }), 'noop');
  assert.strictEqual(decideAction({ id: 't1', client_id: 'abc.access' }, null), 'rotate');
  assert.strictEqual(decideAction({ id: 't1', client_id: 'abc.access' }, { clientId: 'old.access' }), 'rotate');
});
test('enroll attestation names agent and plane; plane label is a safe slug', () => {
  assert.strictEqual(attestSentence('bosun', 'aegis-vm'), 'I approve enrolling bosun in the control plane aegis-vm');
  assert.strictEqual(planeName('AEGIS-VM'), 'aegis-vm');
  assert.strictEqual(planeName('Marcus PC!'), 'marcus-pc');
  assert.strictEqual(planeName('---'), 'aegis');
});

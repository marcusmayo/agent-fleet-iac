'use strict';
// discover reconciles what Azure holds (agent RG tags) against this plane's registry. Two planes,
// two registries, one Azure -- this is how each plane sees the other's work. Pure function tests.
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcile } = require('../lib/discover');

const rg = (agent, profile, location = 'northcentralus', extra = {}) => ({ name: 'rg-' + agent, location, tags: { app: 'agent-fleet', agent, profile, ...extra } });
const names = (l) => l.map((a) => a.name);

test('registered = in both; unenrolled = in Azure only (an enroll away); gone = in registry only', () => {
  const r = reconcile([{ name: 'atlas-01', profile: 'keel' }, { name: 'atlas-02', profile: 'castor' }],
    [rg('atlas-01', 'keel'), rg('atlas-03', 'castor', 'northcentralus')]);
  assert.deepStrictEqual(names(r.registered), ['atlas-01']);
  assert.deepStrictEqual(names(r.unenrolled), ['atlas-03']);
  assert.strictEqual(r.unenrolled[0].profile, 'castor');
  assert.strictEqual(r.unenrolled[0].region, 'northcentralus');
  assert.deepStrictEqual(names(r.gone), ['atlas-02']);
});

test('the control plane RG and mistagged groups are not agents and are ignored', () => {
  const r = reconcile([], [
    { name: 'rg-aegis', location: 'northcentralus', tags: { app: 'agent-fleet', role: 'control-plane', agent: 'aegis' } },
    { name: 'rg-other', location: 'eastus2', tags: { app: 'something-else', agent: 'x', profile: 'keel' } },
    { name: 'rg-noprofile', location: 'eastus2', tags: { app: 'agent-fleet', agent: 'y' } },
    { name: 'rg-mismatch', location: 'eastus2', tags: { app: 'agent-fleet', agent: 'z', profile: 'keel' } },
  ]);
  assert.deepStrictEqual(names(r.unenrolled), ['z']);   // only the well-tagged one is an agent
  assert.deepStrictEqual(r.gone, []);
});

test('empty inputs and malformed entries never throw', () => {
  assert.deepStrictEqual(reconcile(null, null), { registered: [], unenrolled: [], gone: [] });
  const r = reconcile([{ name: 'a' }, null, {}], [null, {}, { name: 'rg-a', tags: null }]);
  assert.deepStrictEqual(names(r.gone), ['a']);
});

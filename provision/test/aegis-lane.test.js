'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { evalCapacity } = require('../lib/capacity');
const { attestSentence, VERBS } = require('../lib/aegis-grant');

const REGION = 'northcentralus';
const sku = (name, family, vcpus, restrictions = []) => ({ name, family, restrictions, capabilities: [{ name: 'vCPUs', value: String(vcpus) }] });
const usage = (pairs) => pairs.map(([v, limit, currentValue]) => ({ name: { value: v }, limit, currentValue }));

test('capacity FAILS with the exact quota request when the family has zero cores (the live failure)', () => {
  const r = evalCapacity(REGION, 'Standard_B2ats_v2', {
    skus: [sku('Standard_B2ats_v2', 'standardBasv2Family', 2)],
    usage: usage([['cores', 10, 0], ['standardBasv2Family', 0, 0]]),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /standardBasv2Family in northcentralus: limit 0, used 0, need 2/);
  assert.match(r.request, /az quota create --resource-name standardBasv2Family --scope \/subscriptions\/<sub-id>\/providers\/Microsoft\.Compute\/locations\/northcentralus --resource-type dedicated --limit-object value=10/);
});

test('capacity PASSES once the family has headroom', () => {
  const r = evalCapacity(REGION, 'Standard_B2ats_v2', {
    skus: [sku('Standard_B2ats_v2', 'standardBasv2Family', 2)],
    usage: usage([['cores', 10, 0], ['standardBasv2Family', 10, 0]]),
  });
  assert.strictEqual(r.ok, true);
  assert.match(r.detail, /standardBasv2Family 0\/10 used, \+2 fits · regional 0\/10/);
});

test('capacity FAILS on a subscription restriction even with quota (eastus2 shape)', () => {
  const r = evalCapacity('eastus2', 'Standard_B2ts_v2', {
    skus: [sku('Standard_B2ts_v2', 'standardBsv2Family', 2, [{ reasonCode: 'NotAvailableForSubscription' }])],
    usage: usage([['cores', 10, 0], ['standardBsv2Family', 10, 0]]),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /NotAvailableForSubscription/);
  assert.strictEqual(r.request, undefined);
});

test('capacity FAILS on regional total vCPUs when the family alone would pass', () => {
  const r = evalCapacity(REGION, 'Standard_B2ats_v2', {
    skus: [sku('Standard_B2ats_v2', 'standardBasv2Family', 2)],
    usage: usage([['cores', 10, 9], ['standardBasv2Family', 10, 0]]),
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /regional vCPUs in northcentralus: limit 10, used 9, need 2/);
  assert.match(r.request, /--resource-name cores .*value=11/);
});

test('capacity FAILS loudly when the size is not offered, or the catalog/usage is unreadable', () => {
  assert.strictEqual(evalCapacity(REGION, 'Standard_B2ats_v2', { skus: [sku('Standard_B2als_v2', 'standardBasv2Family', 2)], usage: [] }).ok, false);
  assert.match(evalCapacity(REGION, 'Standard_B2ats_v2', { skus: null, usage: [], skusErr: 'boom' }).detail, /unreadable \(boom\)/);
  const r = evalCapacity(REGION, 'Standard_B2ats_v2', { skus: [sku('Standard_B2ats_v2', 'standardBasv2Family', 2)], usage: null });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /quota usage for northcentralus unreadable/);
});

test('capacity treats an empty/absent limit as unreadable, never as zero-and-fine', () => {
  const r = evalCapacity(REGION, 'Standard_B2ats_v2', {
    skus: [sku('Standard_B2ats_v2', 'standardBasv2Family', 2)],
    usage: [{ name: { value: 'standardBasv2Family' }, limit: '', currentValue: 0 }],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /unreadable/);
});

test('grant lane: exactly two verbs, neither can express Owner or User Access Administrator', () => {
  assert.deepStrictEqual(Object.keys(VERBS).sort(), ['contributor', 'vault']);
  for (const v of Object.values(VERBS)) assert.ok(!/Owner|User Access Administrator/.test(v.role), v.role);
  assert.ok(Object.isFrozen(VERBS));
});

test('grant lane: attestation sentences are per-verb and name the vault', () => {
  const v = { fleetVaultName: 'kv-keelpm-aegis' };
  assert.strictEqual(attestSentence('aegis', 'vault', v), 'I approve granting the control plane aegis read on kv-keelpm-aegis');
  assert.strictEqual(attestSentence('aegis', 'contributor', v), 'I approve granting the control plane aegis Contributor on the subscription');
});

'use strict';
// One store, three classes, the same for every agent. Retention is a property of the CONTAINER,
// never of the agent, so there is no per-agent policy to set or forget. The rule that matters is
// structural: Azure lifecycle filters are include-only, so the delete rule NAMES the operational
// containers it may empty and cannot reach the permanent classes at all. Before this, the delete
// rule carried no prefixMatch and applied to every container in the account -- a notebook or a
// chain written into that store would have been destroyed on day fifteen.
const { test } = require('node:test');
const assert = require('node:assert');
const bk = require('../lib/backup');

const del = (pol) => (pol.rules || []).filter((r) => r.definition && r.definition.actions
  && r.definition.actions.baseBlob && r.definition.actions.baseBlob.delete);
const byName = (pol, n) => (pol.rules || []).find((r) => r.name === n);

test('the delete rule names the operational containers and nothing else', () => {
  const pol = bk.lifecyclePolicy(['alpha', 'bravo']);
  const r = byName(pol, 'fleet-backup-retention');
  assert.deepStrictEqual(r.definition.filters.prefixMatch, ['alpha/', 'bravo/']);
  assert.strictEqual(r.definition.actions.baseBlob.delete.daysAfterModificationGreaterThan, bk.RETENTION_DAYS);
});

test('NO delete action can reach a permanent class -- the structural guarantee', () => {
  const pol = bk.lifecyclePolicy(['alpha', 'bravo']);
  for (const r of del(pol)) {
    for (const p of r.definition.filters.prefixMatch || []) {
      assert.ok(!bk.RESERVED.some((c) => p.startsWith(c + '/')), `delete rule ${r.name} reaches ${p}`);
    }
  }
});

test('an empty fleet produces NO delete rule at all -- not a rule that matches everything', () => {
  const pol = bk.lifecyclePolicy([]);
  assert.strictEqual(byName(pol, 'fleet-backup-retention'), undefined);
  assert.strictEqual(del(pol).length, 0);
  assert.strictEqual(pol.rules.length, 2, 'the two permanent classes are still governed');
});

test('records and ledgers age Cool 30 / Archive 180 and carry no delete action', () => {
  const pol = bk.lifecyclePolicy(['alpha']);
  for (const n of ['fleet-records-tiering', 'fleet-ledgers-tiering']) {
    const b = byName(pol, n).definition.actions.baseBlob;
    assert.strictEqual(b.tierToCool.daysAfterModificationGreaterThan, 30);
    assert.strictEqual(b.tierToArchive.daysAfterModificationGreaterThan, 180);
    assert.strictEqual(b.delete, undefined, n + ' must never delete');
  }
});

test('the index prefix is named by no rule, so a year-old lookup stays instant', () => {
  const pol = bk.lifecyclePolicy(['alpha']);
  const prefixes = (pol.rules || []).flatMap((r) => r.definition.filters.prefixMatch || []);
  assert.ok(prefixes.includes('records/data/'), 'bulk records tier');
  assert.ok(!prefixes.some((p) => 'records/index/'.startsWith(p) && p !== 'records/index/'
    ? p === 'records/' : p === 'records/index/'), 'nothing tiers the index');
  assert.ok(!prefixes.includes('records/'), 'a bare records/ prefix would drag the index into Archive');
});

test('enrolling an agent is additive and idempotent', () => {
  let pol = bk.lifecyclePolicy(['alpha']);
  pol = bk.withOperational(pol, 'bravo');
  assert.deepStrictEqual(byName(pol, 'fleet-backup-retention').definition.filters.prefixMatch, ['alpha/', 'bravo/']);
  pol = bk.withOperational(pol, 'bravo');
  assert.deepStrictEqual(byName(pol, 'fleet-backup-retention').definition.filters.prefixMatch, ['alpha/', 'bravo/']);
  assert.strictEqual(pol.rules.length, 3, 'the permanent rules are rebuilt, never duplicated');
});

test('enrolling into a store that has no delete rule yet creates one for that agent only', () => {
  const pol = bk.withOperational(bk.lifecyclePolicy([]), 'alpha');
  assert.deepStrictEqual(byName(pol, 'fleet-backup-retention').definition.filters.prefixMatch, ['alpha/']);
});

test('a permanent class can never be enrolled into deletion', () => {
  for (const n of bk.RESERVED) {
    assert.throws(() => bk.withOperational(bk.lifecyclePolicy(['alpha']), n), /never enrolled into deletion/);
  }
  assert.throws(() => bk.withOperational(bk.lifecyclePolicy(['alpha']), ''), /unnamed/);
});

test('a trailing slash in a container name does not create a second prefix', () => {
  const pol = bk.withOperational(bk.lifecyclePolicy(['alpha']), 'alpha/');
  assert.deepStrictEqual(byName(pol, 'fleet-backup-retention').definition.filters.prefixMatch, ['alpha/']);
});

test('a live policy read back from Azure round-trips through enrolment', () => {
  // shape az returns from `management-policy show --query policy`
  const live = { rules: [{ enabled: true, name: 'fleet-backup-retention', type: 'Lifecycle',
    definition: { filters: { blobTypes: ['blockBlob'], prefixMatch: ['alpha/'] },
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 14 } } } } }] };
  const pol = bk.withOperational(live, 'bravo');
  assert.deepStrictEqual(byName(pol, 'fleet-backup-retention').definition.filters.prefixMatch, ['alpha/', 'bravo/']);
  assert.strictEqual(pol.rules.length, 3, 'a store predating the classes gains them on the next enrolment');
});

test('an unreadable policy (az failed -> null) still yields a safe document', () => {
  const pol = bk.withOperational(null, 'alpha');
  assert.deepStrictEqual(byName(pol, 'fleet-backup-retention').definition.filters.prefixMatch, ['alpha/']);
  assert.strictEqual(del(pol).length, 1);
});

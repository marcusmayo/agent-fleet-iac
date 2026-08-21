'use strict';
// Reading the store has to be honest about the back room. An Archive blob cannot be downloaded
// at all, and the failure we refuse to ship is a fetch that dies with a raw Azure error instead
// of saying what state the blob is in and how long retrieval takes. These are the pure
// decisions -- what a row is, and what can be done with it -- with no az anywhere near them.
const { test } = require('node:test');
const assert = require('node:assert');
const bk = require('../lib/backup');

const TSV = [
  'records/index/2026-08.json\tHot\tNone\t2026-08-21T03:15:00+00:00\t20480',
  'records/data/2026-08-21.jsonl.gz\tNone\tNone\t2026-08-21T03:15:00+00:00\t524288',
  'records/data/2025-07-02.jsonl.gz\tArchive\tNone\t2025-07-02T03:15:00+00:00\t498123',
  'records/data/2025-08-02.jsonl.gz\tArchive\trehydrate-pending-to-hot\t2025-08-02T03:15:00+00:00\t501001',
  'ledgers/aegis/2026-08-20.json.gz\tCool\tNone\t2026-08-20T03:15:00+00:00\t81920',
].join('\n');

test('rows parse, and a blob that was never tiered reads as Hot rather than unknown', () => {
  const rows = bk.blobRows(TSV);
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows[1].tier, 'Hot', 'None means it has never been tiered — that is Hot');
  assert.strictEqual(rows[1].archiveStatus, null);
  assert.strictEqual(rows[0].size, 20480);
  assert.strictEqual(rows[4].tier, 'Cool');
});

test('empty and ragged input never throws', () => {
  assert.deepStrictEqual(bk.blobRows(''), []);
  assert.deepStrictEqual(bk.blobRows(null), []);
  assert.deepStrictEqual(bk.blobRows('\t\t\t\t'), []);
  assert.strictEqual(bk.blobRows('lonely-name').length, 1);
});

test('Hot and Cool download; Archive refuses and says why', () => {
  const rows = bk.blobRows(TSV);
  assert.strictEqual(bk.fetchPlan(rows[0]).act, 'download');
  assert.strictEqual(bk.fetchPlan(rows[1]).act, 'download');
  assert.strictEqual(bk.fetchPlan(rows[4]).act, 'download', 'Cool is readable directly — that is the point of 180 days');
  const cold = bk.fetchPlan(rows[2]);
  assert.strictEqual(cold.act, 'rehydrate');
  assert.match(cold.why, /Archive/);
  assert.match(cold.why, /180/, 'the refusal says when a blob falls into the back room');
});

test('a rehydration already running is its own state, not a second request', () => {
  const rows = bk.blobRows(TSV);
  const p = bk.fetchPlan(rows[3]);
  assert.strictEqual(p.act, 'pending');
  assert.match(p.why, /in progress/);
});

test('a missing or malformed row is never treated as downloadable by accident', () => {
  assert.strictEqual(bk.fetchPlan({ tier: 'Archive' }).act, 'rehydrate');
  assert.strictEqual(bk.fetchPlan({}).act, 'download', 'no tier at all is Hot');
  assert.strictEqual(bk.fetchPlan(null).act, 'download');
});

test('the ETA is stated as a range, never as a promise', () => {
  assert.match(bk.rehydrateEta('High'), /under an hour/);
  assert.match(bk.rehydrateEta('high'), /under an hour/);
  assert.match(bk.rehydrateEta('Standard'), /15 hours/);
  assert.match(bk.rehydrateEta(undefined), /under an hour/, 'High is the default for objects this size');
});

test('blob names are charset-gated before they reach az', () => {
  assert.ok(bk.safeBlobName('ledgers/2026-08-21T03-15-00Z.json.gz'));
  assert.ok(bk.safeBlobName('records/index/2026-08.json'));
  assert.ok(!bk.safeBlobName(''));
  assert.ok(!bk.safeBlobName('../etc/passwd'));
  assert.ok(!bk.safeBlobName('name with spaces'));
  assert.ok(!bk.safeBlobName('a$(whoami).gz'));
  assert.ok(!bk.safeBlobName('-leading-dash'));
});

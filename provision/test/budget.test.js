'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const budget = require('../lib/budget');

test('checkBudget BLOCKS when spend >= budget', () => {
  const r = budget.checkBudget(150, { ok: true, amount: 150.0, unit: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.over, true);
  assert.match(r.message, /refusing new provisioning/);
});

test('checkBudget PASSES with headroom', () => {
  const r = budget.checkBudget(150, { ok: true, amount: 42.5, unit: 'USD' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.over, false);
  assert.match(r.message, /headroom 107\.50/);
});

test('checkBudget WARNS but does not block when spend is unreadable', () => {
  const r = budget.checkBudget(150, { ok: false, reason: 'budget not found' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warn, true);
  assert.match(r.message, /relying on the maxFleet cap/);
});

test('checkBudget WARNS on null spend', () => {
  const r = budget.checkBudget(150, null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warn, true);
});

test('readBudgetSpend degrades gracefully when az is unavailable', () => {
  // Make az unavailable for this call rather than assuming the machine has none: on an
  // operator's workstation az IS present, read the real budget, and this test failed the
  // first time the suite ran there. An empty PATH gives the same "not found" everywhere
  // (on win32 the shell itself is found through ComSpec, not PATH). Must return { ok:false }
  // with a reason, never throw.
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-az-'));
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const saved = process.env[key];
  process.env[key] = empty;
  let s;
  try { s = budget.readBudgetSpend('fleet-monthly'); }
  finally { process.env[key] = saved; fs.rmSync(empty, { recursive: true, force: true }); }
  assert.strictEqual(s.ok, false);
  assert.ok(typeof s.reason === 'string' && s.reason.length > 0);
});

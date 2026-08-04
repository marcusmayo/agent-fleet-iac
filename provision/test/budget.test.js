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

test('readBudgetSpend degrades gracefully when az is unavailable (sandbox)', () => {
  // No az on PATH here -> not found / non-zero; must return { ok:false } not throw.
  const s = budget.readBudgetSpend('fleet-monthly');
  assert.strictEqual(s.ok, false);
  assert.ok(typeof s.reason === 'string' && s.reason.length > 0);
});

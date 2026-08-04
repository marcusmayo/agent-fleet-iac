'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const policy = require('../lib/policy');

const P = { maxFleet: 6, maxBatch: 2, allowedRegions: ['eastus2'], defaultRegion: 'eastus2', maxMonthlyBudgetUsd: 150 };

test('loadPolicy falls back to built-in defaults when no file resolves', () => {
  const p = policy.loadPolicy('/definitely/not/a/real/path.jsonc');
  assert.strictEqual(p.maxFleet, policy.DEFAULTS.maxFleet);
  assert.strictEqual(p.maxBatch, policy.DEFAULTS.maxBatch);
  assert.deepStrictEqual(p.allowedRegions, policy.DEFAULTS.allowedRegions);
});

test('loadPolicy reads the committed aegis.policy.jsonc (with comments)', () => {
  const p = policy.loadPolicy(path.join(__dirname, '..', 'aegis.policy.jsonc'));
  assert.strictEqual(p.maxFleet, 6);
  assert.strictEqual(p.maxBatch, 2);
  assert.deepStrictEqual(p.allowedRegions, ['eastus2']);
  assert.strictEqual(p.maxMonthlyBudgetUsd, 150);
});

test('gate PASSES a first agent in an allowed region', () => {
  const r = policy.checkProvision(P, { currentFleet: ['bosun'], names: ['atlas-01'], region: 'eastus2' });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
});

test('gate BLOCKS a disallowed region', () => {
  const r = policy.checkProvision(P, { currentFleet: [], names: ['atlas-01'], region: 'westus2' });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /region "westus2" is not in allowedRegions/);
});

test('gate BLOCKS when it would exceed maxFleet', () => {
  const full = ['a', 'b', 'c', 'd', 'e', 'f']; // 6 = maxFleet
  const r = policy.checkProvision(P, { currentFleet: full, names: ['g'], region: 'eastus2' });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /over maxFleet=6/);
});

test('re-provisioning an already-registered agent does NOT count against maxFleet', () => {
  const full = ['a', 'b', 'c', 'd', 'e', 'f']; // at cap
  const r = policy.checkProvision(P, { currentFleet: full, names: ['c'], region: 'eastus2' }); // c already in fleet
  assert.strictEqual(r.ok, true, r.errors.join('; '));
});

test('gate BLOCKS a batch larger than maxBatch', () => {
  const r = policy.checkProvision(P, { currentFleet: [], names: ['a', 'b', 'c'], region: 'eastus2' });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /exceeds maxBatch=2/);
});

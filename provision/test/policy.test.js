'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const policy = require('../lib/policy');

const P = { maxFleet: 6, maxBatch: 2, allowedRegions: ['eastus2'], defaultRegion: 'eastus2', maxMonthlyBudgetUsd: 150 };

// Hermetic on purpose. In a checkout the resolver ALWAYS finds provision/aegis.policy.jsonc
// (a bogus explicit path falls through to it), and on an operator's workstation that file is
// the LIVE policy that `fleetctl policy set` edits under attestation -- so a test that read it
// and expected the committed numbers passed in the sandbox by coincidence and failed on the
// workstation the first time the suite ran there. The no-file branch is reached by injecting
// the resolver; the parser is exercised on a fixture copy; the live file is checked for shape.
test('loadPolicy falls back to built-in defaults when no file resolves', () => {
  const p = policy.loadPolicy('/definitely/not/a/real/path.jsonc', () => null);
  assert.strictEqual(p.source, '(built-in defaults)');
  assert.strictEqual(p.maxFleet, policy.DEFAULTS.maxFleet);
  assert.strictEqual(p.maxBatch, policy.DEFAULTS.maxBatch);
  assert.deepStrictEqual(p.allowedRegions, policy.DEFAULTS.allowedRegions);
});

test('loadPolicy reads a policy file with comments (fixture copy of the committed policy)', () => {
  const p = policy.loadPolicy(path.join(__dirname, 'fixtures', 'aegis.policy.sample.jsonc'));
  assert.strictEqual(p.maxFleet, 6);
  assert.strictEqual(p.maxBatch, 2);
  assert.deepStrictEqual(p.allowedRegions, ['eastus2']);
  assert.strictEqual(p.maxMonthlyBudgetUsd, 150);
});

test('the live provision/aegis.policy.jsonc parses and has every policy key with the right shape', () => {
  // values are the operator's business (attested policy.set edits this file); the shape is ours
  const p = policy.loadPolicy(path.join(__dirname, '..', 'aegis.policy.jsonc'));
  assert.ok(Number.isInteger(p.maxFleet) && p.maxFleet > 0, 'maxFleet is a positive integer');
  assert.ok(Number.isInteger(p.maxBatch) && p.maxBatch > 0, 'maxBatch is a positive integer');
  assert.ok(Array.isArray(p.allowedRegions) && p.allowedRegions.length > 0, 'allowedRegions is a non-empty list');
  assert.ok(p.allowedRegions.includes(p.defaultRegion), 'defaultRegion is one of allowedRegions');
  assert.ok(typeof p.maxMonthlyBudgetUsd === 'number' && p.maxMonthlyBudgetUsd > 0, 'maxMonthlyBudgetUsd is a positive number');
  assert.ok(typeof p.budgetName === 'string' && p.budgetName.length > 0, 'budgetName is a non-empty string');
  assert.ok(Array.isArray(p.protectedAgents), 'protectedAgents is a list');
  assert.ok(Array.isArray(p.a2aPairs), 'a2aPairs is a list');
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

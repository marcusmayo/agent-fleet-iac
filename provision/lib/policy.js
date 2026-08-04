'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { findFleetRoot } = require('./util');
const { stripJsonc } = require('./jsonc');

// Built-in defaults so the gate is safe even if the policy file is missing.
const DEFAULTS = {
  maxFleet: 6,
  maxBatch: 2,
  allowedRegions: ['eastus2'],
  defaultRegion: 'eastus2',
  maxMonthlyBudgetUsd: 150,
  budgetName: 'fleet-monthly',
};

function resolvePolicyPath(explicit) {
  const tries = [];
  if (explicit) tries.push(path.resolve(explicit));
  if (process.env.AEGIS_POLICY) tries.push(path.resolve(process.env.AEGIS_POLICY));
  const root = findFleetRoot();
  if (root) tries.push(path.join(root, 'provision', 'aegis.policy.jsonc'));
  tries.push(path.resolve(__dirname, '..', 'aegis.policy.jsonc')); // …/provision/lib -> …/provision
  for (const p of tries) if (fs.existsSync(p)) return p;
  return null;
}

function loadPolicy(explicit) {
  const p = resolvePolicyPath(explicit);
  if (!p) return { ...DEFAULTS, source: '(built-in defaults)' };
  let raw;
  try { raw = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8'))); }
  catch (e) { throw new Error(`aegis.policy.jsonc is invalid (${e.message})`); }
  return { ...DEFAULTS, ...raw, source: p };
}

// Fail-closed provisioning gate.
//   currentFleet: names already registered in aegis.config.json
//   names:        agent name(s) being provisioned this request
//   region:       target Azure region
// Returns { ok, errors }. Re-provisioning an already-registered agent does not
// count against maxFleet (it's an update, not a new agent).
function checkProvision(policy, { currentFleet = [], names = [], region } = {}) {
  const errors = [];
  const inFleet = new Set(currentFleet);
  const netNew = names.filter((n) => !inFleet.has(n));

  if (names.length > policy.maxBatch) {
    errors.push(`batch of ${names.length} exceeds maxBatch=${policy.maxBatch} — request ${policy.maxBatch} or fewer at a time`);
  }
  const projected = currentFleet.length + netNew.length;
  if (projected > policy.maxFleet) {
    errors.push(`would bring the fleet to ${projected}, over maxFleet=${policy.maxFleet} (${currentFleet.length} registered + ${netNew.length} new)`);
  }
  if (region && Array.isArray(policy.allowedRegions) && !policy.allowedRegions.includes(region)) {
    errors.push(`region "${region}" is not in allowedRegions [${policy.allowedRegions.join(', ')}]`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { DEFAULTS, resolvePolicyPath, loadPolicy, checkProvision };

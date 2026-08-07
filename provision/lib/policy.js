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

// ---------------------------------------------------------------------------
// Attested policy mutation. The policy file is the reviewable governance
// artifact, so `set` performs a GUARDED value swap that preserves every comment
// (never a JSON round-trip): the exact `"<key>": <old>` token must match once.
// The attestation phrase must equal the canonical sentence verbatim; anything
// else refuses, mutates nothing, and the refusal is still LEDGERED. Every
// attempt appends {ts, actor, deployerObjectId, action, key, from, to, phrase,
// outcome} to provision/policy-audit.jsonl — append-only attestation evidence.
const SETTABLE = { maxFleet: 'maxFleet', budget: 'maxMonthlyBudgetUsd' };

function attestPhrase(key, value) {
  return `I approve setting ${key} to ${value}`;
}

function auditPath(policyPath) {
  return path.join(path.dirname(policyPath), 'policy-audit.jsonl');
}

function ledger(policyPath, entry) {
  const rec = {
    ts: new Date().toISOString(),
    actor: (require('node:os').userInfo().username || 'unknown'),
    deployerObjectId: (process.env.DEPLOYER_OBJECT_ID || '').trim() || null,
    ...entry,
  };
  fs.appendFileSync(auditPath(policyPath), JSON.stringify(rec) + '\n');
  return rec;
}

function showPolicy(explicit) {
  const pol = loadPolicy(explicit);
  const lines = [`policy source: ${pol.source}`];
  for (const k of Object.keys(DEFAULTS)) lines.push(`  ${k}: ${JSON.stringify(pol[k])}`);
  const ap = pol.source.endsWith('.jsonc') ? auditPath(pol.source) : null;
  if (ap && fs.existsSync(ap)) {
    const tail = fs.readFileSync(ap, 'utf8').trim().split('\n').slice(-3);
    lines.push(`  recent attested actions (${path.basename(ap)}):`);
    for (const t of tail) lines.push(`    ${t}`);
  }
  return lines.join('\n');
}

function setPolicy({ key, value, attest, explicit }) {
  const fileKey = SETTABLE[key];
  if (!fileKey) throw new Error(`policy set: unknown key "${key}" — settable: ${Object.keys(SETTABLE).join(', ')}`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`policy set: ${key} must be a positive integer (got "${value}")`);
  const p = resolvePolicyPath(explicit);
  if (!p) throw new Error('policy set: no aegis.policy.jsonc found — the gate file must exist to be edited');
  const before = loadPolicy(p)[fileKey];
  const required = attestPhrase(key, n);
  if ((attest || '').trim() !== required) {
    ledger(p, { action: 'policy.set', key: fileKey, from: before, to: n, phrase: attest || '', outcome: 'refused: attestation mismatch' });
    throw new Error(`policy set REFUSED — attestation must read exactly:\n  --attest "${required}"`);
  }
  const src = fs.readFileSync(p, 'utf8');
  const token = `"${fileKey}": ${before},`;
  const hits = src.split(token).length - 1;
  if (hits !== 1) throw new Error(`policy set aborted: expected exactly one \`${token}\` in ${p}, found ${hits} — edit by hand`);
  fs.writeFileSync(p, src.replace(token, `"${fileKey}": ${n},`));
  const after = loadPolicy(p)[fileKey];
  if (after !== n) throw new Error(`policy set verification failed: re-read ${fileKey}=${after}, expected ${n}`);
  const rec = ledger(p, { action: 'policy.set', key: fileKey, from: before, to: n, phrase: attest, outcome: 'ok' });
  return { path: p, key: fileKey, from: before, to: n, ledgered: rec.ts };
}

module.exports = { DEFAULTS, resolvePolicyPath, loadPolicy, checkProvision, showPolicy, setPolicy, attestPhrase };

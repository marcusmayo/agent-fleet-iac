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
const SETTABLE = {
  maxFleet:       { file: 'maxFleet',            kind: 'int' },
  maxBatch:       { file: 'maxBatch',            kind: 'int' },
  budget:         { file: 'maxMonthlyBudgetUsd', kind: 'int' },
  allowedRegions: { file: 'allowedRegions',      kind: 'list' },   // comma-separated full replacement
  defaultRegion:  { file: 'defaultRegion',       kind: 'str', re: /^[a-z0-9]{3,30}$/ },
  budgetName:     { file: 'budgetName',          kind: 'str', re: /^[A-Za-z0-9_-]{1,63}$/ },
};

// Parse + shape-validate; throws with the ledgerable reason on bad input.
function coerce(key, spec, value) {
  if (spec.kind === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${key} must be a positive integer (got "${value}")`);
    return n;
  }
  if (spec.kind === 'str') {
    const s = String(value || '').trim();
    if (!spec.re.test(s)) throw new Error(`${key} "${s}" fails ${spec.re}`);
    return s;
  }
  const list = [...new Set(String(value || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!list.length || list.some((s) => !/^[a-z0-9]{3,30}$/.test(s))) {
    throw new Error(`${key} must be a comma-separated list of azure region names (got "${value}")`);
  }
  return list;
}

// Coherence gates across keys -- fail closed with the exact fix named.
function crossCheck(fileKey, next, pol) {
  if (fileKey === 'maxBatch' && next > pol.maxFleet) {
    throw new Error(`maxBatch ${next} would exceed maxFleet ${pol.maxFleet} -- raise maxFleet first`);
  }
  if (fileKey === 'maxFleet' && pol.maxBatch > next) {
    throw new Error(`maxFleet ${next} would drop below maxBatch ${pol.maxBatch} -- lower maxBatch first`);
  }
  if (fileKey === 'allowedRegions' && !next.includes(pol.defaultRegion)) {
    throw new Error(`allowedRegions [${next.join(', ')}] would exclude defaultRegion "${pol.defaultRegion}" -- change defaultRegion first or include it`);
  }
  if (fileKey === 'defaultRegion' && !pol.allowedRegions.includes(next)) {
    throw new Error(`defaultRegion "${next}" is not in allowedRegions [${pol.allowedRegions.join(', ')}] -- add it to allowedRegions first`);
  }
}

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
  const spec = SETTABLE[key];
  if (!spec) throw new Error(`policy set: unknown key "${key}" -- settable: ${Object.keys(SETTABLE).join(', ')}`);
  const p = resolvePolicyPath(explicit);
  if (!p) throw new Error('policy set: no aegis.policy.jsonc found -- the gate file must exist to be edited');
  const pol = loadPolicy(p);
  const before = pol[spec.file];
  let next;
  try { next = coerce(key, spec, value); }
  catch (e) {
    ledger(p, { action: 'policy.set', key: spec.file, from: before, to: String(value), phrase: attest || '', outcome: 'refused: ' + e.message });
    throw new Error('policy set REFUSED -- ' + e.message);
  }
  const required = attestPhrase(key, String(value).trim());
  if ((attest || '').trim() !== required) {
    ledger(p, { action: 'policy.set', key: spec.file, from: before, to: next, phrase: attest || '', outcome: 'refused: attestation mismatch' });
    throw new Error(`policy set REFUSED -- attestation must read exactly:\n  --attest "${required}"`);
  }
  try { crossCheck(spec.file, next, pol); }
  catch (e) {
    ledger(p, { action: 'policy.set', key: spec.file, from: before, to: next, phrase: attest, outcome: 'refused: ' + e.message });
    throw new Error('policy set REFUSED -- ' + e.message);
  }
  const src2 = fs.readFileSync(p, 'utf8');
  const token = `"${spec.file}": ${JSON.stringify(before)}`;
  const hits = src2.split(token).length - 1;
  if (hits !== 1) throw new Error(`policy set aborted: expected exactly one \`${token}\` in ${p}, found ${hits} -- edit by hand`);
  fs.writeFileSync(p, src2.replace(token, `"${spec.file}": ${JSON.stringify(next)}`));
  const after = loadPolicy(p)[spec.file];
  if (JSON.stringify(after) !== JSON.stringify(next)) throw new Error(`policy set verification failed: re-read ${spec.file}=${JSON.stringify(after)}`);
  // Azure budget-object sync (2nd step of the budget control): the GATE mutation
  // above is the enforcement and always lands; syncing the Cost Management budget
  // object is best-effort, FAIL-LOUD-NON-BLOCKING -- its outcome rides the ledger.
  let syncOutcome;
  if (spec.file === 'maxMonthlyBudgetUsd') {
    const { spawnSync } = require('node:child_process');
    // Node >=20.12 (CVE-2024-27980) forbids spawning .cmd without a shell (EINVAL),
    // and args-array+shell triggers DEP0190 -- so on Windows we build ONE command
    // string (every value charset-gated above/below) and run it with shell:true.
    const runAz = (azArgs) => {
      const r2 = process.platform === 'win32'
        ? spawnSync('az ' + azArgs.join(' '), { shell: true, encoding: 'utf8', timeout: 45000 })
        : spawnSync('az', azArgs, { encoding: 'utf8', timeout: 45000 });
      const out = (r2.stdout || '').trim();
      // az prefixes preview/deprecation WARNINGs on stderr -- surface the first REAL line.
      const errLines = ((r2.stderr || '') + (r2.error ? String(r2.error) : '')).split('\n').map(s => s.trim()).filter(Boolean);
      const err = (errLines.find(l => !l.startsWith('WARNING')) || errLines[0] || 'no output').slice(0, 200);
      return { status: r2.status, out, err };
    };
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(pol.budgetName)) {
      syncOutcome = 'failed: budgetName in policy file fails safe charset [A-Za-z0-9_-]';
    } else {
      const u = runAz(['consumption', 'budget', 'update', '--budget-name', pol.budgetName, '--amount', String(next), '--query', 'amount', '-o', 'tsv']);
      if (u.status === 0 && u.out) {
        syncOutcome = `ok: ${pol.budgetName} amount=${u.out}`;
      } else if (/\(404\)|No budget found/i.test(u.err)) {
        // SELF-HEAL: the Cost Management budget object was never created -- create it
        // now (Cost category, Monthly grain, current-month start) so the attested gate
        // value and the Azure alerting object stay one and the same from here on.
        const now = new Date();
        const startD = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
        const endD = `${now.getUTCFullYear() + 5}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
        const c = runAz(['consumption', 'budget', 'create', '--budget-name', pol.budgetName, '--amount', String(next),
                         '--category', 'cost', '--time-grain', 'monthly', '--start-date', startD, '--end-date', endD,
                         '--query', 'amount', '-o', 'tsv']);
        syncOutcome = (c.status === 0 && c.out)
          ? `ok: created ${pol.budgetName} amount=${c.out} (monthly, from ${startD})`
          : `failed: create after 404: ${c.err}`;
      } else {
        syncOutcome = `failed: ${u.err}`;
      }
    }
  }
  const rec = ledger(p, { action: 'policy.set', key: spec.file, from: before, to: next, phrase: attest, outcome: 'ok', ...(syncOutcome ? { syncOutcome } : {}) });
  return { path: p, key: spec.file, from: before, to: next, ledgered: rec.ts, syncOutcome };
}

module.exports = { DEFAULTS, resolvePolicyPath, loadPolicy, checkProvision, showPolicy, setPolicy, attestPhrase };

'use strict';
// Decommission deletes the fleet-protect lock -- the last structure between an operator error
// and an RG delete -- as an "orphan" whenever policy says the agent is not protected. But
// built-in defaults carry an empty protectedAgents list that reads exactly like a policy
// saying no, loadPolicy only threw on an unparseable file, and $AEGIS_POLICY pointing at a
// path that did not exist fell silently through to a DIFFERENT file. Two policy files exist in
// this fleet (the hosted plane's live copy, the workstation checkout), so the mirror could be
// removed on the strength of a file nobody named. A named path now fails loud, the read
// carries its provenance, and one verdict governs both the plan and the delete.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProtection, resolvePolicyPath } = require('../lib/policy');
const { lockVerdict } = require('../lib/decommission');

function withPolicyFile(body, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protread-'));
  const p = path.join(tmp, 'aegis.policy.jsonc');
  fs.writeFileSync(p, body);
  try { return fn(p); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function withEnv(pairs, fn) {
  const saved = {};
  for (const k of Object.keys(pairs)) { saved[k] = process.env[k]; if (pairs[k] === undefined) delete process.env[k]; else process.env[k] = pairs[k]; }
  try { return fn(); } finally { for (const k of Object.keys(pairs)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('$AEGIS_POLICY naming a file that does not exist FAILS -- it never falls through to another one', () => {
  const missing = path.join(os.tmpdir(), 'no-such-policy-' + process.pid + '.jsonc');
  withEnv({ AEGIS_POLICY: missing }, () => {
    assert.throws(() => resolvePolicyPath(), /policy file not found/);
    const r = readProtection();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /policy file not found/);
  });
});

test('an explicit path that does not exist FAILS the same way', () => {
  withEnv({ AEGIS_POLICY: undefined }, () => {
    assert.throws(() => resolvePolicyPath('/definitely/not/a/real/policy.jsonc'), /policy file not found/);
  });
});

test('implicit discovery still falls through (no path was named, so nothing was claimed)', () => {
  withEnv({ AEGIS_POLICY: undefined }, () => {
    assert.ok(resolvePolicyPath(), 'a checkout resolves its own provision/aegis.policy.jsonc');
  });
});

test('a named policy that says not protected -> ok, with the file named', () => {
  withPolicyFile('{ "protectedAgents": ["other"] }', (p) => {
    const r = readProtection(p);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, p);
    assert.deepStrictEqual(r.protectedAgents, ['other']);
  });
});

test('a named policy that says protected -> ok, and the name is in the list', () => {
  withPolicyFile('{ "protectedAgents": ["probe"] }', (p) => {
    const r = readProtection(p);
    assert.strictEqual(r.ok, true);
    assert.ok(r.protectedAgents.includes('probe'));
  });
});

test('an unparseable policy -> not ok, and the reason says so', () => {
  withPolicyFile('{ "protectedAgents": [ ', (p) => {
    const r = readProtection(p);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /invalid/);
    assert.strictEqual(r.source, null);
  });
});

test('built-in defaults are NOT a statement that an agent is unprotected', () => {
  const r = readProtection.length >= 0 && (() => {
    const { loadPolicy } = require('../lib/policy');
    // resolver injected to reach the no-file branch, the way policy.test.js does it
    const pol = loadPolicy(undefined, () => null);
    assert.strictEqual(pol.source, '(built-in defaults)');
    assert.deepStrictEqual(pol.protectedAgents, []);
    return { ok: pol.source !== '(built-in defaults)' };
  })();
  assert.strictEqual(r.ok, false, 'an empty default list must not read as a policy saying no');
});

test('verdict: no locks -> proceed', () => {
  const v = lockVerdict([], { ok: true, source: '/p/aegis.policy.jsonc' });
  assert.strictEqual(v.act, 'proceed');
  assert.strictEqual(v.mirror.length, 0);
});

test('verdict: the mirror plus a named policy -> proceed, carrying the file that judged it', () => {
  const v = lockVerdict([{ name: 'fleet-protect', level: 'CanNotDelete' }], { ok: true, source: '/p/aegis.policy.jsonc' });
  assert.strictEqual(v.act, 'proceed');
  assert.strictEqual(v.source, '/p/aegis.policy.jsonc');
  assert.strictEqual(v.mirror.length, 1);
});

test('verdict: the mirror with NO readable policy -> refuse, never removed on a default', () => {
  for (const prot of [undefined, null, { ok: false, error: 'no policy file resolved (built-in defaults answered)' }]) {
    const v = lockVerdict([{ name: 'fleet-protect', level: 'CanNotDelete' }], prot);
    assert.strictEqual(v.act, 'refuse-unjudged', JSON.stringify(prot));
    assert.ok(v.why, 'the refusal says why');
  }
});

test('verdict: a foreign lock refuses first, even with a readable policy', () => {
  const v = lockVerdict([{ name: 'someone-elses', level: 'CanNotDelete' }, { name: 'fleet-protect', level: 'CanNotDelete' }], { ok: true, source: '/p/aegis.policy.jsonc' });
  assert.strictEqual(v.act, 'refuse-foreign');
  assert.strictEqual(v.foreign.length, 1);
  assert.strictEqual(v.mirror.length, 1);
});

test('source guard: the plan and the delete read the SAME verdict function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'decommission.js'), 'utf8');
  assert.strictEqual(src.split('lockVerdict(s.locks, s.protection)').length - 1, 2, 'printPlan and execute must both call it');
  assert.strictEqual(src.split("l.name !== 'fleet-protect'").length - 1, 1, 'the fleet-protect rule lives in one place only');
});

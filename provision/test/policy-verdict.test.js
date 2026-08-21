'use strict';
// A control with a second, structural layer is only fully applied when both layers land.
// The policy write is the gate; the Azure mirror (a CanNotDelete lock, the Cost Management
// budget object) is best-effort. Both ledger sites used to write outcome: 'ok' as a literal,
// so an unprotect whose lock delete failed with AuthorizationFailed ledgered ok on the
// fleetctl ledger AND on the plane's chain, the CLI returned 0, and the panel -- which reads
// nothing but the exit code -- flipped the guard green. The verdict is now derived from the
// sync line, and these tests hold that: the word, the reason carried verbatim, and the two
// source guards that stop the literal from coming back.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncVerdict, ledger } = require('../lib/policy');

test('no second layer -> ok (most keys have no Azure mirror at all)', () => {
  assert.strictEqual(syncVerdict(undefined), 'ok');
  assert.strictEqual(syncVerdict(''), 'ok');
});

test('mirror landed -> ok (lock and budget both say so with an ok prefix)', () => {
  assert.strictEqual(syncVerdict('ok: locked rg-probe'), 'ok');
  assert.strictEqual(syncVerdict('ok: unlocked rg-probe'), 'ok');
  assert.strictEqual(syncVerdict('ok: fleet-monthly amount=150 (ARM put, monthly from 2026-08-01)'), 'ok');
});

test('lock sync failed -> incomplete, never ok, never failed', () => {
  const v = syncVerdict('unlock rg-probe failed: AuthorizationFailed');
  assert.ok(v.startsWith('incomplete:'), v);
  assert.ok(!/^ok/.test(v), v);
  assert.ok(!/^failed/.test(v), v);
});

test('the reason rides the verdict verbatim -- the ledger reads why without a second lookup', () => {
  const why = 'lock rg-probe failed: AuthorizationFailed: does not have authorization to perform action';
  assert.ok(syncVerdict(why).endsWith(why), syncVerdict(why));
});

test('a partly-applied bulk edit is incomplete even though one name locked', () => {
  const v = syncVerdict('locked rg-alpha; lock rg-bravo failed: AuthorizationFailed');
  assert.ok(v.startsWith('incomplete:'), v);
});

test('a failed budget object put is incomplete -- the spend gate applied, the ARM object did not', () => {
  assert.ok(syncVerdict('failed: budgetName in policy file fails safe charset [A-Za-z0-9_-]').startsWith('incomplete:'));
  assert.ok(syncVerdict('failed: (AuthorizationFailed) The client does not have authorization').startsWith('incomplete:'));
  // the budget lane's own line already begins `failed:` -- the verdict must not stutter it back
  assert.strictEqual(syncVerdict('failed: no output'), 'incomplete: policy applied, azure sync failed -- no output');
});

test('ok is a prefix WORD, not a substring -- an agent named ok-something cannot launder a failure', () => {
  assert.ok(syncVerdict('lock rg-ok-agent failed: AuthorizationFailed').startsWith('incomplete:'));
  assert.ok(syncVerdict('okay: whatever this is').startsWith('incomplete:'));
});

test('the verdict reaches the ledger record and the file on disk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-verdict-'));
  const p = path.join(tmp, 'aegis.policy.jsonc');
  fs.writeFileSync(p, '{ "protectedAgents": [] }');
  const saved = process.env.DEPLOYER_OBJECT_ID;
  process.env.DEPLOYER_OBJECT_ID = '00000000-0000-0000-0000-000000000000';
  try {
    const sync = 'unlock rg-probe failed: AuthorizationFailed';
    const rec = ledger(p, { action: 'policy.unprotect', key: 'protectedAgents', name: 'probe', outcome: syncVerdict(sync), syncOutcome: sync });
    assert.ok(rec.outcome.startsWith('incomplete:'), rec.outcome);
    const line = JSON.parse(fs.readFileSync(path.join(tmp, 'policy-audit.jsonl'), 'utf8').trim().split('\n').pop());
    assert.ok(line.outcome.startsWith('incomplete:'), line.outcome);
    assert.strictEqual(line.syncOutcome, sync);
  } finally {
    if (saved === undefined) delete process.env.DEPLOYER_OBJECT_ID; else process.env.DEPLOYER_OBJECT_ID = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('source guard: neither ledger site asserts ok, and the CLI exits non-zero on incomplete', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'policy.js'), 'utf8');
  assert.strictEqual(lib.split("outcome: 'ok'").length - 1, 0, "policy.js asserts outcome: 'ok' again -- the verdict must be derived");
  assert.strictEqual(lib.split('const outcome = syncVerdict(syncOutcome);').length - 1, 2, 'both ledger sites must derive the verdict');
  const cli = fs.readFileSync(path.join(__dirname, '..', 'bin', 'fleetctl.js'), 'utf8');
  assert.strictEqual(cli.split("String(r.outcome || '').startsWith('incomplete')").length - 1, 2, 'protect/unprotect and set must both exit non-zero on incomplete');
});

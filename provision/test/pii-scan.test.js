'use strict';
// The weekly PII scan. Both profiles' compliance boards read logs/pii-scan.log and flag it stale
// past eight days -- and until this lane existed, nothing anywhere wrote that file, so every
// board carried "weekly scan log not present yet" forever. The scan runs the profile's OWN
// scanner (scripts/scan-tree.js) inside the webchat container, where the tree, node and the
// logs volume live. Findings are the point of the log, never a failure of the run: the service
// exits non-zero only when the scan could not run at all.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.resolve(__dirname, '..', '..', 'core');
const SRC = fs.readFileSync(path.join(CORE, 'pii-scan.sh'), 'utf8');
const CI = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bicep', 'cloud-init', 'agent-cloudflared.yaml'), 'utf8');

test('the scan writes the exact file the compliance boards read', () => {
  assert.match(SRC, /logs\/pii-scan\.log/);
  assert.match(SRC, /scan-tree\.js/);
});

test('findings are recorded, not obeyed -- the scanner exit code lands IN the log', () => {
  assert.match(SRC, /scan exit=\$\?/, 'a reader can tell clean from found-things without guessing');
  assert.ok(!/scan-tree\.js[^\n]*&&/.test(SRC), 'the log write must not be conditional on a clean scan');
});

test('a container that is not running aborts non-zero and says the log was untouched', () => {
  assert.match(SRC, /not running/);
  assert.match(SRC, /log untouched/);
});

test('the scan is in the vendored set in BOTH implementations, or the manifest lies', () => {
  const sync = fs.readFileSync(path.join(CORE, 'sync-core.sh'), 'utf8');
  assert.strictEqual(sync.split('pii-scan.sh').length - 1, 2, 'both enumerations in sync-core.sh');
  const man = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core-manifest.js'), 'utf8');
  assert.ok(man.includes("'pii-scan.sh'"));
  assert.match(fs.readFileSync(path.join(CORE, 'manifest.sha256'), 'utf8'), /\bpii-scan\.sh$/m);
});

test('the scanner ignores fixtures and its own report, allows the fleet identity, and still catches a real leak', () => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  fs.mkdirSync(path.join(t, 'tests')); fs.mkdirSync(path.join(t, 'logs'));
  fs.writeFileSync(path.join(t, 'tests', 'test_x.js'), 'aws AKIAIOSFODNN7EXAMPLE ssn 123-45-6789\n');
  fs.writeFileSync(path.join(t, 'run_e2e.sh'), 'seed ssn 123-45-6789\n');
  fs.writeFileSync(path.join(t, 'logs', 'pii-scan.log'), 'PII SCAN quoted EMAIL a@b.com SSN 123-45-6789\n');
  fs.writeFileSync(path.join(t, 'logs', 'audit.jsonl'), '{"actor":"keel@keel-pm.com"}\n');
  const run = () => { try { execFileSync('node', [path.join(CORE, 'scan-tree.js'), t], { encoding: 'utf8' }); return { code: 0, out: '' }; } catch (e) { return { code: e.status, out: String(e.stderr || '') }; } };
  const clean = run();
  assert.strictEqual(clean.code, 0, 'fixtures, the self-log and the fleet identity must scan clean:\n' + clean.out);
  fs.appendFileSync(path.join(t, 'logs', 'audit.jsonl'), '{"detail":"real.person@gmail.com"}\n');
  const leak = run();
  assert.strictEqual(leak.code, 1, 'a real address in the audit chain must still fire');
  assert.match(leak.out, /audit\.jsonl/, 'and be named');
  fs.rmSync(t, { recursive: true, force: true });
});

test('the fleet is Azure, so the patterns detect AZURE secrets -- and not its benign identifiers', () => {
  const { PATTERNS } = require(path.join(CORE, 'redaction-gate.js'));
  const hits = (str) => PATTERNS.filter(([, re]) => { re.lastIndex = 0; return re.test(str); }).map(([l]) => l);
  assert.deepStrictEqual(hits('AccountKey=abcDEF123+/abcDEF123+/abcDEF123=='), ['AZURE_CONN'], 'connection-string key');
  assert.deepStrictEqual(hits('?sv=2021&sig=abcDEF123abcDEF123abcDEF123abcDEF'), ['AZURE_SAS'], 'SAS signature');
  assert.deepStrictEqual(hits('k: ' + 'A'.repeat(86) + '=='), ['AZURE_KEY'], 'bare 88-char storage key');
  for (const benign of ['vault: smalt-kv-qdwhg rg-smalt', 'MSI_CLIENT_ID=6f16530b-b7e9-4d4c-ac43-9d105842a1aa', 'castor:de336b9', 'x: ' + 'A'.repeat(40) + '==']) {
    assert.deepStrictEqual(hits(benign), [], 'must not fire on: ' + benign);
  }
});

test('cloud-init installs a WEEKLY timer that catches up after a missed window', () => {
  assert.ok(CI.includes('agent-pii-scan.timer'));
  assert.ok(CI.includes('OnCalendar=Sun'), 'weekly, not a five-minute cadence');
  assert.ok(CI.includes('Persistent=true'), 'a Sunday the VM slept through runs at next boot, not never');
  const b64 = (CI.match(/echo ([A-Za-z0-9+/=]{40,}) \| base64 -d > \/usr\/local\/bin\/agent-pii-scan/) || [])[1];
  assert.ok(b64, 'the wrapper ships as base64 like the others');
  const wrapper = Buffer.from(b64, 'base64').toString('utf8');
  assert.match(wrapper, /\[ -f /, 'guard is -f: vendored scripts land 100644');
  assert.ok(!/\[ -x /.test(wrapper), 'an -x guard silently disables the scan on every agent');
});

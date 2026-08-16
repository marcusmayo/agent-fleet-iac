'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { recordSizeInContract, attestSentence } = require('../lib/resize');
const { loadContract } = require('../lib/contract');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

test('resize: attestation names agent and size', () => {
  assert.strictEqual(attestSentence('bosun', 'Standard_B2als_v2'), 'I approve resizing bosun to Standard_B2als_v2');
});
test('resize: recordSizeInContract inserts after region, replaces an existing value, refuses ambiguity', () => {
  const a = '{ "contract": 1, "name": "x", "profile": "keel", "region": "eastus2" }';
  const b = recordSizeInContract(a, 'Standard_B2als_v2');
  assert.strictEqual(b, '{ "contract": 1, "name": "x", "profile": "keel", "region": "eastus2", "vmSize": "Standard_B2als_v2" }');
  assert.strictEqual(recordSizeInContract(b, 'Standard_D2s_v3'), '{ "contract": 1, "name": "x", "profile": "keel", "region": "eastus2", "vmSize": "Standard_D2s_v3" }');
  const noRegion = '{ "contract": 1, "name": "x", "profile": "keel", "domain": "example.com" }';
  assert.match(recordSizeInContract(noRegion, 'Standard_B2als_v2'), /"profile": "keel", "vmSize": "Standard_B2als_v2", "domain"/);
  assert.throws(() => recordSizeInContract('{ "vmSize": "a", "vmSize": "b" }', 'Standard_X'), /2 vmSize fields/);
});
test('contract: vmSize is optional, validated, and drives derive + deployEnv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
  const f = path.join(dir, 'a.agent.jsonc');
  fs.writeFileSync(f, '{ "contract": 1, "name": "alpha", "profile": "keel", "vmSize": "Standard_B2als_v2" }');
  const r = loadContract(f); assert.strictEqual(r.ok, true); assert.strictEqual(r.value.vmSize, 'Standard_B2als_v2');
  const { derive } = require('../lib/derive'); assert.strictEqual(derive(r.value).azure.vmSize, 'Standard_B2als_v2');
  const { deployEnv } = require('../lib/up'); assert.strictEqual(deployEnv(r.value, 'ssh-ed25519 AAA', 'tok').VM_SIZE, 'Standard_B2als_v2');
  fs.writeFileSync(f, '{ "contract": 1, "name": "alpha", "profile": "keel", "vmSize": "b2" }');
  const bad = loadContract(f); assert.strictEqual(bad.ok, false); assert.ok(bad.errors.some((e) => /vmSize/.test(e)));
  fs.writeFileSync(f, '{ "contract": 1, "name": "alpha", "profile": "keel" }');
  const none = loadContract(f); assert.strictEqual(none.ok, true); assert.strictEqual(none.value.vmSize, '');
});

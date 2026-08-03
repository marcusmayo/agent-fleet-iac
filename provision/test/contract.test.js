'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  validateContract, loadContract,
  PROFILE_REPO, DEFAULT_DOMAIN, DEFAULT_PORT, DEFAULT_REGION,
} = require('../lib/contract');

const F = (name) => path.join(__dirname, 'fixtures', name);

test('minimal valid contract resolves defaults + per-profile repo', () => {
  const r = loadContract(F('valid.agent.jsonc'));
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.strictEqual(r.value.domain, DEFAULT_DOMAIN);
  assert.strictEqual(r.value.webchatPort, DEFAULT_PORT);
  assert.strictEqual(r.value.region, DEFAULT_REGION);
  assert.strictEqual(r.value.sshCidr, '');
  assert.strictEqual(r.value.repoUrl, PROFILE_REPO.keel);
  assert.strictEqual(r.value.repoUrlIsDefault, true);
});

test('full contract (with comments + trailing comma) parses and keeps overrides', () => {
  const r = loadContract(F('valid-full.agent.jsonc'));
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.strictEqual(r.value.profile, 'castor');
  assert.strictEqual(r.value.sshCidr, '203.0.113.5/32');
  assert.strictEqual(r.value.repoRef, 'a431079');
  assert.strictEqual(r.value.repoUrlIsDefault, false);
});

test('rejects a secret-shaped key', () => {
  const r = loadContract(F('bad-secret-key.agent.jsonc'));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /secret-shaped key/);
});

test('rejects an unknown key (catches typos)', () => {
  const r = loadContract(F('bad-unknown-key.agent.jsonc'));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /unknown key "webChatPort"/);
});

test('rejects a non-allowlisted profile', () => {
  const r = loadContract(F('bad-profile.agent.jsonc'));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /profile.*castor \| keel/);
});

test('rejects an invalid name', () => {
  const r = loadContract(F('bad-name.agent.jsonc'));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /name/);
});

test('fails closed on an unknown contract major', () => {
  const r = loadContract(F('bad-contract.agent.jsonc'));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /contract major 2 not supported/);
});

test('rejects a malformed CIDR', () => {
  const r = loadContract(F('bad-cidr.agent.jsonc'));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /sshCidr/);
});

test('rejects a trailing-hyphen name (invalid DNS label)', () => {
  const r = validateContract({ contract: 1, name: 'atlas-', profile: 'keel' });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /hyphen/);
});

test('rejects a port out of range', () => {
  const r = validateContract({ contract: 1, name: 'a1', profile: 'keel', webchatPort: 70000 });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join('\n'), /webchatPort/);
});

test('rejects a non-object contract', () => {
  assert.strictEqual(validateContract(null).ok, false);
  assert.strictEqual(validateContract([]).ok, false);
  assert.strictEqual(validateContract('nope').ok, false);
});

test('castor profile resolves the castor default repo', () => {
  const r = validateContract({ contract: 1, name: 'cerberus', profile: 'castor' });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  assert.strictEqual(r.value.repoUrl, PROFILE_REPO.castor);
});

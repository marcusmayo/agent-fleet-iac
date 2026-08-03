'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { deployEnv } = require('../lib/up');
const { validateContract, PROFILE_REPO } = require('../lib/contract');

// Root-cause regression: a present-but-empty REPO_URL env var makes the
// bicepparam skip its default, so cloud-init runs `git clone ''`. deployEnv
// must therefore ALWAYS carry the resolved, non-empty repo URL.

test('deployEnv: default-repo contract still passes the RESOLVED repo url (never empty)', () => {
  const r = validateContract({ contract: 1, name: 'example-01', profile: 'keel' });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  const env = deployEnv(r.value, 'ssh-ed25519 AAAA test', 'tunnel-token');
  assert.strictEqual(env.REPO_URL, PROFILE_REPO.keel);
  assert.ok(env.REPO_URL.length > 0, 'REPO_URL must never be empty');
  assert.strictEqual(env.REPO_REF, '');
  assert.strictEqual(env.AZ_LOCATION, 'eastus2');
  assert.strictEqual(env.SSH_CIDR, '');
});

test('deployEnv: explicit repo override + cidr + ref pass through', () => {
  const r = validateContract({
    contract: 1, name: 'cerberus', profile: 'castor',
    repoUrl: 'https://github.com/marcusmayo/castor.git', repoRef: 'a431079', sshCidr: '203.0.113.5/32',
  });
  assert.strictEqual(r.ok, true, r.errors.join('; '));
  const env = deployEnv(r.value, 'key', 'tok');
  assert.strictEqual(env.REPO_URL, 'https://github.com/marcusmayo/castor.git');
  assert.strictEqual(env.REPO_REF, 'a431079');
  assert.strictEqual(env.SSH_CIDR, '203.0.113.5/32');
  assert.strictEqual(env.CF_TUNNEL_TOKEN, 'tok');
  assert.strictEqual(env.SSH_PUBKEY, 'key');
});

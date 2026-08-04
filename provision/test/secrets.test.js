'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../lib/secrets');

// RFC 4648 base32 test vectors (no padding)
test('base32 matches RFC 4648 vectors', () => {
  const v = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' };
  for (const [inp, exp] of Object.entries(v)) {
    assert.strictEqual(s.base32(Buffer.from(inp)), exp, `base32("${inp}")`);
  }
});

test('genTotp yields a base32 secret and a well-formed otpauth URI', () => {
  const { secret, uri } = s.genTotp('Keel', 'atlas-01');
  assert.match(secret, /^[A-Z2-7]{32}$/);                 // 160-bit -> 32 base32 chars
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes(`secret=${secret}`));
  assert.ok(uri.includes('issuer=Keel'));
  assert.ok(uri.includes('Keel%3Aatlas-01'));             // label issuer:account, URI-encoded
});

test('genTotp secrets are random (no fixed seed)', () => {
  assert.notStrictEqual(s.genTotp('Keel', 'a').secret, s.genTotp('Keel', 'a').secret);
});

test('resolveVault degrades gracefully when az is unavailable (sandbox)', () => {
  const r = s.resolveVault('atlas-01');
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

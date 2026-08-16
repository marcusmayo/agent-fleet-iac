'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../lib/secrets');

// App-TOTP was removed fleet-wide (edge-only Cloudflare Access); the base32/genTotp
// helpers went with it, and so did their tests.
test('resolveVault degrades gracefully when az is unavailable (sandbox)', () => {
  const r = s.resolveVault('atlas-01');
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

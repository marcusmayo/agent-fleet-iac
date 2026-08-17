'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../lib/secrets');

// App-TOTP was removed fleet-wide (edge-only Cloudflare Access); the base32/genTotp
// helpers went with it, and so did their tests.
test('resolveVault degrades gracefully when az is unavailable', () => {
  // az is made unavailable for the call (empty PATH; on win32 the shell is found via ComSpec)
  // rather than assumed absent -- an operator's workstation has az, and a name that happens to
  // exist there would turn this into a live read. Must return { ok:false } with a reason.
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-az-'));
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const saved = process.env[key];
  process.env[key] = empty;
  let r;
  try { r = s.resolveVault('atlas-01'); }
  finally { process.env[key] = saved; fs.rmSync(empty, { recursive: true, force: true }); }
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

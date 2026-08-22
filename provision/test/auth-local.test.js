'use strict';
// AUTH_MODE=local -- the stranger's front door. The fleet's auth is edge-only: the webchat
// trusts Cloudflare Access headers and 403s everything else, which is right behind a tunnel and
// a locked door for someone who just ran `docker compose up`. Local mode opens it, and these
// tests pin the three properties that make that safe to ship in the same core the fleet runs:
// only the literal 'local' relaxes anything; it is read from the environment at request time so
// an image cannot bake it on; and unset-or-anything-else behaves byte-identically to before.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../../core/auth');

const fakeRes = () => {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.type = () => r;
  r.send = (b) => { r.body = b; return r; };
  return r;
};
const run = (env, headers) => {
  const prev = process.env.AUTH_MODE;
  if (env === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = env;
  try {
    const res = fakeRes(); let passed = false;
    auth.requireAuth({ headers: headers || {} }, res, () => { passed = true; });
    return { passed, code: res.code };
  } finally {
    if (prev === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prev;
  }
};

test('unset: a bare request is refused 403 -- byte-identical to before local mode existed', () => {
  const r = run(undefined, {});
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.code, 403);
});

test('unset: the edge headers still pass, exactly as before', () => {
  assert.strictEqual(run(undefined, { 'cf-access-client-id': 'x' }).passed, true);
  assert.strictEqual(run(undefined, { 'cf-access-jwt-assertion': 'y' }).passed, true);
});

test('only the literal "local" relaxes -- empty, LOCAL-ish typos and other values stay closed', () => {
  for (const v of ['', 'true', '1', 'localhost', 'Local ', 'dev', 'off']) {
    const r = run(v, {});
    if (v.trim().toLowerCase() === 'local') continue;
    assert.strictEqual(r.code, 403, JSON.stringify(v) + ' must refuse');
  }
  assert.strictEqual(run('local', {}).passed, true, 'the literal opens it');
  assert.strictEqual(run(' LOCAL ', {}).passed, true, 'trimmed case-fold of the literal is the same word');
});

test('request-time read: flipping the environment flips behaviour with no restart', () => {
  assert.strictEqual(run('local', {}).passed, true);
  assert.strictEqual(run(undefined, {}).code, 403, 'the same process refuses again the moment it is unset');
});

test('the mode is LOUD: banner endpoint, banner UI, and a boot warning all exist', () => {
  const ops = fs.readFileSync(path.resolve(__dirname, '..', '..', 'core', 'webchat-ops.js'), 'utf8');
  assert.match(ops, /\/auth-mode/);
  const controls = fs.readFileSync(path.resolve(__dirname, '..', '..', 'core', 'webchat-controls.js'), 'utf8');
  assert.match(controls, /localAuthBanner/);
  assert.match(controls, /Never expose this port/);
  const a = fs.readFileSync(path.resolve(__dirname, '..', '..', 'core', 'auth.js'), 'utf8');
  assert.match(a, /edge auth DISABLED/);
});

'use strict';
// A teardown that cannot find its own registry must say so and count it as a failed surface -- never
// print "not registered", skip it, and call the run complete. Live: probe was decommissioned from a
// workstation with neither $AEGIS_CONFIG nor --aegis-config; the lane read only those two, found
// nothing, skipped surface 1 as "already gone", printed complete, and aegis.config.json still listed
// probe. Every other lane resolves the registry through aegisconfig.resolveConfigPath; now so does this.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registryState } = require('../lib/decommission');

function withEnv(pairs, fn) {
  const saved = {};
  for (const k of Object.keys(pairs)) { saved[k] = process.env[k]; if (pairs[k] === undefined) delete process.env[k]; else process.env[k] = pairs[k]; }
  try { return fn(); } finally { for (const k of Object.keys(pairs)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('registry resolved and the agent present -> DEREGISTER (aegis true, path named)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-reg-'));
  const f = path.join(tmp, 'aegis.config.json');
  fs.writeFileSync(f, JSON.stringify({ agents: [{ name: 'probe', profile: 'keel', host: 'probe.example.com', clientId: 'x', clientSecret: 'y' }] }));
  const r = withEnv({ AEGIS_CONFIG: undefined, AEGIS_DIR: undefined }, () => registryState(f, 'probe'));
  assert.strictEqual(r.aegisResolved, true);
  assert.strictEqual(r.aegis, true);
  assert.strictEqual(path.resolve(r.aegisPath), path.resolve(f));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('registry resolved and the agent absent -> not registered (a real answer, not a guess)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-reg-'));
  const f = path.join(tmp, 'aegis.config.json');
  fs.writeFileSync(f, JSON.stringify({ agents: [{ name: 'other', profile: 'keel', host: 'o.example.com', clientId: 'x', clientSecret: 'y' }] }));
  const r = withEnv({ AEGIS_CONFIG: undefined, AEGIS_DIR: undefined }, () => registryState(f, 'probe'));
  assert.strictEqual(r.aegisResolved, true);
  assert.strictEqual(r.aegis, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('no registry resolvable -> UNRESOLVED, distinct from not registered (the failure that shipped)', () => {
  // Hermetic: the resolver's last try is the aegis checkout BESIDE the fleet root, and on an
  // operator's workstation that file exists (it is the live registry) -- a first cut of this test
  // assumed it did not and failed there. So the test supplies its own fleet root ($FLEET_DIR, made
  // valid with the two files findFleetRoot looks for) with no aegis/ beside it, a bogus explicit
  // path, and no env; then nothing can resolve anywhere.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-reg-'));
  const root = path.join(tmp, 'fleet');
  fs.mkdirSync(path.join(root, 'bicep'), { recursive: true }); fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bicep', 'main.bicep'), ''); fs.writeFileSync(path.join(root, 'scripts', 'deploy.sh'), '');
  const bogus = path.join(tmp, 'nope', 'aegis.config.json');
  const r = withEnv({ AEGIS_CONFIG: undefined, AEGIS_DIR: undefined, FLEET_DIR: root }, () => registryState(bogus, 'probe'));
  assert.strictEqual(r.aegisResolved, false, 'resolved to ' + r.aegisPath);
  assert.strictEqual(r.aegis, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('$AEGIS_CONFIG is honoured when no flag is given (what the hosted plane sets)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decom-reg-'));
  const f = path.join(tmp, 'live.json');
  fs.writeFileSync(f, JSON.stringify({ agents: [{ name: 'probe', profile: 'keel', host: 'p.example.com', clientId: 'x', clientSecret: 'y' }] }));
  const r = withEnv({ AEGIS_CONFIG: f, AEGIS_DIR: undefined }, () => registryState(undefined, 'probe'));
  assert.strictEqual(r.aegisResolved, true);
  assert.strictEqual(r.aegis, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

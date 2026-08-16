'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveScope, volSuffixes, memberPatterns, transformExpr, targetScript, attestSentence, globLike } = require('../lib/migrate');
const { VERBS, attestSentence: grantSentence } = require('../lib/aegis-grant');

const KEEL = ['keel_keel-state', 'keel_keel-knowledge', 'keel_keel-logs', 'keel_keel-support', 'keel_keel-exports', 'keel_keel-claude', 'keel_keel-gateway-cache'];
const CASTOR = ['castor_castor-state', 'castor_castor-knowledge', 'castor_castor-logs', 'castor_castor-inbox', 'castor_castor-claude'];

test('volSuffixes reads only this profile\'s volumes', () => {
  assert.deepStrictEqual(volSuffixes(KEEL.concat(['other_x-y']), 'keel'), ['claude', 'exports', 'gateway-cache', 'knowledge', 'logs', 'state', 'support']);
  assert.deepStrictEqual(volSuffixes(CASTOR, 'keel'), []);
});
test('same profile: default = everything but logs; logs requested -> refused', () => {
  const r = resolveScope('keel', 'keel', volSuffixes(KEEL, 'keel'), volSuffixes(KEEL, 'keel'), null);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.scope, ['claude', 'exports', 'gateway-cache', 'knowledge', 'state', 'support']);
  const bad = resolveScope('keel', 'keel', volSuffixes(KEEL, 'keel'), volSuffixes(KEEL, 'keel'), ['knowledge', 'logs']);
  assert.strictEqual(bad.ok, false); assert.match(bad.why, /not allowed .*: logs/);
});
test('cross profile: default knowledge; claude opt-in; state/logs/exports refused', () => {
  const s = volSuffixes(KEEL, 'keel'), t = volSuffixes(CASTOR, 'castor');
  const d = resolveScope('keel', 'castor', s, t, null);
  assert.deepStrictEqual(d.scope, ['knowledge']); assert.deepStrictEqual(d.allowed, ['claude', 'knowledge']);
  assert.strictEqual(resolveScope('keel', 'castor', s, t, ['knowledge', 'claude']).ok, true);
  for (const bad of ['state', 'logs', 'exports', 'support']) {
    const r = resolveScope('keel', 'castor', s, t, [bad]); assert.strictEqual(r.ok, false, bad); assert.match(r.why, new RegExp(bad));
  }
});
test('cross profile with nothing shareable refuses loudly', () => {
  const r = resolveScope('keel', 'castor', ['logs', 'state'], ['logs', 'state'], null);
  assert.strictEqual(r.ok, false); assert.match(r.why, /nothing to migrate/);
});
test('member patterns + transform: claude brings its session pointers, nothing else from state', () => {
  assert.deepStrictEqual(memberPatterns('keel', ['knowledge', 'claude']), [
    'var/lib/docker/volumes/keel_keel-knowledge/_data*',
    'var/lib/docker/volumes/keel_keel-claude/_data*',
    'var/lib/docker/volumes/keel_keel-state/_data/chat-session*.json',
  ]);
  // state moving whole already carries the pointers; adding the narrower pattern would make GNU tar exit 2 ("Not found in archive")
  assert.deepStrictEqual(memberPatterns('keel', ['state', 'claude']), ['var/lib/docker/volumes/keel_keel-state/_data*', 'var/lib/docker/volumes/keel_keel-claude/_data*']);
  assert.strictEqual(transformExpr('keel', 'castor'), 's#^var/lib/docker/volumes/keel_keel-#var/lib/docker/volumes/castor_castor-#');
  assert.ok(globLike('var/lib/docker/volumes/keel_keel-state/_data/chat-session*.json', 'var/lib/docker/volumes/keel_keel-state/_data/chat-session-direct--x.json'));
  assert.ok(!globLike('var/lib/docker/volumes/keel_keel-state/_data/chat-session*.json', 'var/lib/docker/volumes/keel_keel-state/_data/portfolio.yaml'));
  assert.ok(globLike('var/lib/docker/volumes/keel_keel-knowledge/_data*', 'var/lib/docker/volumes/keel_keel-knowledge/_data/inbox/peer.md'));
});
test('target script: own-identity fetch, volume assertions incl. state for claude, translated extraction, restart, no source-only volume named', () => {
  const s = targetScript({ account: 'fleetbk123', to: 'heimdall', blob: 'migrate-bosun-20260816T170000Z.tar.gz', fromProfile: 'keel', toProfile: 'castor', scope: ['knowledge', 'claude'] });
  assert.match(s, /169\.254\.169\.254\/metadata\/identity/);
  assert.match(s, /https:\/\/\$ACC\.blob\.core\.windows\.net\/\$CT\/\$BLOB/);
  assert.match(s, /ACC=fleetbk123; CT=heimdall; BLOB=migrate-bosun-20260816T170000Z\.tar\.gz/);
  assert.match(s, /for v in castor_castor-knowledge castor_castor-claude castor_castor-state; do \[ -d/);
  assert.match(s, /--transform 's#\^var\/lib\/docker\/volumes\/keel_keel-#var\/lib\/docker\/volumes\/castor_castor-#'/);
  assert.match(s, /'var\/lib\/docker\/volumes\/keel_keel-state\/_data\/chat-session\*\.json'/);
  assert.ok(!/keel_keel-logs|keel_keel-exports/.test(s));
  assert.match(s, /grep -- '-webchat\$'/);
  assert.match(s, /echo "migrated: \$BLOB"/);
});
test('attestation sentence names both agents; overwrite is a different sentence', () => {
  assert.strictEqual(attestSentence('bosun', 'heimdall'), 'I approve migrating bosun to heimdall');
  assert.strictEqual(attestSentence('bosun', 'heimdall', true), 'I approve migrating bosun to heimdall overwriting existing files');
});
test('target script: add-only by default (skip existing + report), --overwrite only when asked', () => {
  const base = { account: 'a', to: 'heimdall', blob: 'b.tar.gz', fromProfile: 'keel', toProfile: 'castor', scope: ['knowledge'] };
  const dflt = targetScript(base), ow = targetScript({ ...base, overwrite: true });
  assert.match(dflt, /--skip-old-files --warning=existing-file/); assert.ok(!/--overwrite/.test(dflt)); assert.match(dflt, /skipped-existing:/); assert.match(dflt, /echo "mode: add-only"/);
  assert.match(ow, /--overwrite/); assert.ok(!/--skip-old-files/.test(ow)); assert.match(ow, /echo "mode: overwrite"/);
});
test('grant lane: three verbs now, still no Owner / User Access Administrator; backups sentence', () => {
  assert.deepStrictEqual(Object.keys(VERBS).sort(), ['backups', 'contributor', 'locks', 'vault']);
  assert.strictEqual(grantSentence('aegis', 'locks', { fleetVaultName: 'kv-keelpm-aegis' }), 'I approve granting the control plane aegis lock management on the subscription');
  for (const v of Object.values(VERBS)) assert.ok(!/Owner|User Access Administrator/.test(v.role), v.role);
  assert.strictEqual(grantSentence('aegis', 'backups', { fleetVaultName: 'kv-keelpm-aegis' }), 'I approve granting the control plane aegis read and write on the fleet backup store');
});

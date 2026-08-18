'use strict';
// An agent records every WS chat turn on its own chain: who (verified) and for whom (asserted),
// bytes/model/duration/rc -- never the text. Same identity rule as the HTTP surfaces.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cs = require('../../core/chat-session');

function tree(labels) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-'));
  fs.mkdirSync(path.join(t, 'system'));
  fs.writeFileSync(path.join(t, 'system', 'agent.yaml'), 'agent_name: "x"\nactor_labels:\n' + Object.entries(labels || {}).map(([k, v]) => `  "${k}": "${v}"\n`).join(''));
  return t;
}
const req = (headers) => ({ headers });

test('a plane-relayed turn: verified actor is the service token (labelled), on-behalf-of is the plane claim asserted by that actor', () => {
  const t = tree({ 'abc.access': 'aegis-control-plane' });
  const id = cs.wsIdentity(req({ 'cf-access-client-id': 'abc.access', 'x-aegis-on-behalf-of': 'telegram:778114954' }), t);
  // the label rides only where js-yaml is installed (every agent image); the id and the src are the fact
  assert.strictEqual(id.actor.src, 'cf-access'); assert.strictEqual(id.actor.id, 'abc.access');
  let hasYaml = true; try { require('js-yaml'); } catch { hasYaml = false; }
  if (hasYaml) assert.strictEqual(id.actor.label, 'aegis-control-plane');
  assert.deepStrictEqual(id.onBehalfOf, { src: 'telegram', id: '778114954', assertedBy: 'abc.access' });
  fs.rmSync(t, { recursive: true, force: true });
});

test('an unattributed caller cannot claim to act for anyone', () => {
  const t = tree({});
  const id = cs.wsIdentity(req({ 'x-aegis-on-behalf-of': 'telegram:778114954' }), t);
  assert.strictEqual(id.actor.src, 'unknown');
  assert.strictEqual(id.onBehalfOf, null);
  fs.rmSync(t, { recursive: true, force: true });
});

test('a direct operator turn (cf-access email) has no on-behalf-of', () => {
  const t = tree({});
  const id = cs.wsIdentity(req({ 'cf-access-authenticated-user-email': 'op@example.com' }), t);
  assert.deepStrictEqual(id.actor, { src: 'cf-access', id: 'op@example.com' });
  assert.strictEqual(id.onBehalfOf, null);
  fs.rmSync(t, { recursive: true, force: true });
});

test('turnRecord carries metadata only -- never the prompt or reply', () => {
  const rec = cs.turnRecord({ actor: { src: 'cf-access', id: 'a' }, onBehalfOf: { src: 'telegram', id: '1', assertedBy: 'a' } },
    { model: 'openrouter/x', promptBytes: 17, replyBytes: 900, durationMs: 1234.6, rc: 0, prompt: 'SECRET TEXT', reply: 'ALSO SECRET' });
  assert.strictEqual(rec.event, 'chat-turn');
  assert.strictEqual(rec.via, 'ws');
  assert.strictEqual(rec.model, 'openrouter/x');
  assert.deepStrictEqual([rec.promptBytes, rec.replyBytes, rec.durationMs, rec.exitCode], [17, 900, 1235, 0]);
  assert.ok(!JSON.stringify(rec).includes('SECRET'), 'no content in the record');
  const bad = cs.turnRecord(null, { rc: 1, error: 'x'.repeat(500) });
  assert.strictEqual(bad.actor.id, 'unattributed');
  assert.strictEqual(bad.error.length, 200);
});

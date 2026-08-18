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

test('turnRecord anchors the content by hash and names the session and turn -- never the words', () => {
  const crypto = require('node:crypto');
  const rec = cs.turnRecord({ actor: { src: 'cf-access', id: 'a' } }, { model: 'm', prompt: 'what is in your queue?', reply: 'Your queue is clear.', durationMs: 10, rc: 0, sessionId: 'sess-1', turnIndex: 7 });
  assert.strictEqual(rec.promptSha256, crypto.createHash('sha256').update('what is in your queue?', 'utf8').digest('hex'));
  assert.strictEqual(rec.replySha256, crypto.createHash('sha256').update('Your queue is clear.', 'utf8').digest('hex'));
  assert.strictEqual(rec.promptBytes, 22); assert.strictEqual(rec.replyBytes, 20);
  assert.strictEqual(rec.sessionId, 'sess-1'); assert.strictEqual(rec.turnIndex, 7);
  assert.ok(!JSON.stringify(rec).includes('queue'), 'no prompt text'); assert.ok(!JSON.stringify(rec).includes('clear'), 'no reply text');
  const empty = cs.turnRecord(null, { rc: 0 });
  assert.strictEqual(empty.promptSha256, null); assert.strictEqual(empty.sessionId, null);
});

test('nextTurnIndex counts per session and starts at 1; currentSessionId picks the newest route file', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'turnidx-'));
  assert.strictEqual(cs.nextTurnIndex(t, 's1'), 1); assert.strictEqual(cs.nextTurnIndex(t, 's1'), 2); assert.strictEqual(cs.nextTurnIndex(t, 's2'), 1);
  cs.writeSessionId(t, 'gw-session', 'gateway', 'openrouter/x');
  assert.strictEqual(cs.currentSessionId(t, 'openrouter/x'), 'gw-session');
  const later = Date.now() + 5000;
  cs.writeSessionId(t, 'direct-session', 'direct', 'openrouter/x');
  fs.utimesSync(cs.sessionFile ? cs.sessionFile(t, 'direct', 'openrouter/x') : path.join(t, 'chat-session-direct--' + 'openrouter/x'.replace(/[^a-z0-9]+/gi, '_') + '.json'), later / 1000, later / 1000);
  assert.strictEqual(cs.currentSessionId(t, 'openrouter/x'), 'direct-session');
  fs.rmSync(t, { recursive: true, force: true });
});

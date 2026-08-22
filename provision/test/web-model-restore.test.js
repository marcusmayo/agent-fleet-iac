'use strict';
// The pre-web model used to live in a browser tab (PREV_SLUG in webchat-controls). Toggle web
// ON in the webchat and OFF from Telegram, the panel, another tab, or after a reload, and
// nothing restored — the agent quietly stayed on the direct-Anthropic model, indefinitely, with
// every surface showing a healthy toggle. A restore that only works from the surface that did
// the enable is not a restore.
//
// The state lives in state/web-access.json now, and the decision is a pure function so every
// branch is testable without a webchat: capture on a forced switch, restore on disable, survive
// a model table that changed underneath the capture, and never lose a capture to a no-op toggle.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cs = require('../../core/chat-session');

const TIERS = [
  { tier: 'routine', slug: 'openrouter/deepseek/deepseek-v4-pro', model_name: 'deepseek-v4-pro' },
  { tier: 'deep', slug: 'openrouter/anthropic/claude-sonnet-4-6', model_name: 'claude-sonnet-4.6' },
  { tier: 'fast', slug: 'openrouter/anthropic/claude-haiku-4.5', model_name: 'claude-haiku-4.5' },
];
const WEBMAP = { 'claude-sonnet-4.6': 'claude-sonnet-4-6', 'claude-haiku-4.5': 'claude-haiku-4-5-20251001' };
const D = (o) => cs.webToggleDecision({ tiers: TIERS, webMap: WEBMAP, ...o });

test('enable on a non-web model: switch to the first web-capable tier and CAPTURE the active', () => {
  const d = D({ enable: true, state: { enabled: false, prevModel: null }, active: 'openrouter/deepseek/deepseek-v4-pro' });
  assert.strictEqual(d.select, 'openrouter/anthropic/claude-sonnet-4-6');
  assert.deepStrictEqual(d.switched, { from: 'openrouter/deepseek/deepseek-v4-pro', to: 'openrouter/anthropic/claude-sonnet-4-6' });
  assert.strictEqual(d.write.prevModel, 'openrouter/deepseek/deepseek-v4-pro', 'the capture is in the WRITE, not in a tab');
  assert.strictEqual(d.write.enabled, true);
});

test('enable on an already web-capable model: no switch, nothing captured', () => {
  const d = D({ enable: true, state: { enabled: false, prevModel: null }, active: 'openrouter/anthropic/claude-haiku-4.5' });
  assert.strictEqual(d.select, null);
  assert.strictEqual(d.write.prevModel, null, 'capturing here would "restore" a model that was never left');
});

test('disable with a capture: restore it and CLEAR the capture', () => {
  const d = D({ enable: false, state: { enabled: true, prevModel: 'openrouter/deepseek/deepseek-v4-pro' }, active: 'openrouter/anthropic/claude-sonnet-4-6' });
  assert.strictEqual(d.select, 'openrouter/deepseek/deepseek-v4-pro');
  assert.deepStrictEqual(d.restored, { to: 'openrouter/deepseek/deepseek-v4-pro' });
  assert.strictEqual(d.write.prevModel, null, 'a restore consumed is a restore cleared');
});

test('disable when the captured model left the routing table: clear, keep the current model, say so', () => {
  const d = D({ enable: false, state: { enabled: true, prevModel: 'openrouter/gone/model' }, active: 'openrouter/anthropic/claude-sonnet-4-6' });
  assert.strictEqual(d.select, null, 'guessing a replacement is worse than staying put');
  assert.strictEqual(d.restored, null);
  assert.strictEqual(d.write.prevModel, null);
  assert.match(d.note, /no longer on a routing tier/);
});

test('disable when nothing was ever captured: nothing to select, nothing invented', () => {
  const d = D({ enable: false, state: { enabled: true, prevModel: null }, active: 'openrouter/anthropic/claude-sonnet-4-6' });
  assert.strictEqual(d.select, null);
  assert.strictEqual(d.write.prevModel, null);
});

test('a same-state toggle keeps a held capture — a double ENABLE must not erase the way back', () => {
  const d = D({ enable: true, state: { enabled: true, prevModel: 'openrouter/deepseek/deepseek-v4-pro' }, active: 'openrouter/anthropic/claude-sonnet-4-6' });
  assert.strictEqual(d.select, null);
  assert.strictEqual(d.write.prevModel, 'openrouter/deepseek/deepseek-v4-pro');
});

test('enable with NO web-capable tier anywhere: web still turns on (best-effort gateway), no capture', () => {
  const d = cs.webToggleDecision({ enable: true, state: { enabled: false, prevModel: null }, tiers: [TIERS[0]], webMap: {}, active: 'openrouter/deepseek/deepseek-v4-pro' });
  assert.strictEqual(d.write.enabled, true);
  assert.strictEqual(d.select, null);
  assert.match(d.note, /no web-capable model/);
});

test('the state round-trips through disk, and a cleared capture does not linger in the file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webstate-'));
  try {
    cs.writeWebState(tmp, { enabled: true, prevModel: 'openrouter/deepseek/deepseek-v4-pro' });
    assert.deepStrictEqual(cs.readWebState(tmp), { enabled: true, prevModel: 'openrouter/deepseek/deepseek-v4-pro' });
    assert.strictEqual(cs.readWebAccess(tmp), true, 'the old boolean reader still agrees');
    cs.writeWebState(tmp, { enabled: false, prevModel: null });
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'web-access.json'), 'utf8'));
    assert.ok(!('prevModel' in raw), 'a consumed capture leaves no key behind');
    assert.deepStrictEqual(cs.readWebState(tmp), { enabled: false, prevModel: null });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

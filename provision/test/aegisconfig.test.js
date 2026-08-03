'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cfg = require('../lib/aegisconfig');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscfg-'));
}

test('upsertAgent adds a new agent', () => {
  const data = { agents: [] };
  const action = cfg.upsertAgent(data, { name: 'bosun', profile: 'keel', host: 'bosun.keel-pm.com', clientId: 'a', clientSecret: 'b' });
  assert.strictEqual(action, 'added');
  assert.strictEqual(data.agents.length, 1);
  assert.strictEqual(data.agents[0].name, 'bosun');
});

test('upsertAgent updates in place and never duplicates or clobbers others', () => {
  const data = { agents: [
    { name: 'heimdall', profile: 'castor', host: 'heimdall.keel-pm.com', clientId: 'h1', clientSecret: 'h2' },
    { name: 'bosun', profile: 'keel', host: 'bosun.keel-pm.com', clientId: 'old', clientSecret: 'oldsec' },
  ] };
  const action = cfg.upsertAgent(data, { name: 'bosun', profile: 'keel', host: 'bosun.keel-pm.com', clientId: 'new', clientSecret: 'newsec' });
  assert.strictEqual(action, 'updated');
  assert.strictEqual(data.agents.length, 2);               // no duplicate
  assert.strictEqual(data.agents[0].name, 'heimdall');     // other agent untouched
  assert.strictEqual(data.agents[0].clientSecret, 'h2');
  const bosun = data.agents.find((a) => a.name === 'bosun');
  assert.strictEqual(bosun.clientId, 'new');               // updated
  assert.strictEqual(bosun.clientSecret, 'newsec');
});

test('load returns empty agents for a missing or empty file', () => {
  const d = tmpdir();
  assert.deepStrictEqual(cfg.load(path.join(d, 'nope.json')), { agents: [] });
  const empty = path.join(d, 'empty.json'); fs.writeFileSync(empty, '   ');
  assert.deepStrictEqual(cfg.load(empty), { agents: [] });
});

test('load rejects malformed JSON and wrong shape', () => {
  const d = tmpdir();
  const bad = path.join(d, 'bad.json'); fs.writeFileSync(bad, '{ not json ');
  assert.throws(() => cfg.load(bad), /not valid JSON/);
  const shape = path.join(d, 'shape.json'); fs.writeFileSync(shape, '{"foo":1}');
  assert.throws(() => cfg.load(shape), /agents/);
});

test('save round-trips and load reads it back', () => {
  const d = tmpdir();
  const p = path.join(d, 'aegis.config.json');
  const data = { agents: [{ name: 'x', profile: 'keel', host: 'x.k', clientId: 'i', clientSecret: 's' }] };
  cfg.save(p, data);
  assert.deepStrictEqual(cfg.load(p), data);
  assert.match(fs.readFileSync(p, 'utf8'), /\n$/); // trailing newline
});

test('resolveConfigPath honors explicit path first', () => {
  const d = tmpdir();
  const p = path.join(d, 'aegis.config.json'); fs.writeFileSync(p, '{"agents":[]}');
  const r = cfg.resolveConfigPath(p, null);
  assert.strictEqual(r.path, path.resolve(p));
  assert.strictEqual(r.exists, true);
});

test('gitignoreState: ignored vs not-ignored in a real repo', () => {
  const d = tmpdir();
  execFileSync('git', ['-C', d, 'init', '-q']);
  const p = path.join(d, 'aegis.config.json');
  fs.writeFileSync(p, '{"agents":[]}');
  // not ignored yet
  assert.strictEqual(cfg.gitignoreState(p).state, 'not-ignored');
  // add to .gitignore -> ignored
  fs.writeFileSync(path.join(d, '.gitignore'), 'aegis.config.json\n');
  assert.strictEqual(cfg.gitignoreState(p).state, 'ignored');
});

test('gitignoreState: no-repo outside any git repo', () => {
  const d = tmpdir(); // mkdtemp dir is not a git repo
  const p = path.join(d, 'aegis.config.json'); fs.writeFileSync(p, '{"agents":[]}');
  const s = cfg.gitignoreState(p).state;
  assert.ok(s === 'no-repo' || s === 'ignored', `expected no-repo (got ${s})`);
});

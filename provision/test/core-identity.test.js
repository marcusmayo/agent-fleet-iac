'use strict';
// An agent's name is the deploy-time value in system/agent.yaml, stated to the model as a per-turn
// fact; the profile brand (Keel, Castor) is its role, not its name. Live: an agent on a VM named
// probe answered "My name is Keel" -- the brand reached the page and the card, not the conversation.
// These test the pure parts of core/chat-session.js: identity read, placeholder rendering, the fact.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cs = require('../../core/chat-session');

function tree(agentYaml, flags) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ident-'));
  fs.mkdirSync(path.join(tmp, 'system'));
  if (agentYaml !== null) fs.writeFileSync(path.join(tmp, 'system', 'agent.yaml'), agentYaml);
  if (flags) fs.writeFileSync(path.join(tmp, '.provision-flags'), flags);
  return tmp;
}

test('identity: agent_name and profile_name from agent.yaml (quoted or bare)', () => {
  const t = tree('agent_name: "probe"\nprofile_name: Keel\npersona: |\n  x\n');
  assert.deepStrictEqual(cs.readIdentity(t), { agentName: 'probe', profileName: 'Keel' });
  fs.rmSync(t, { recursive: true, force: true });
});

test('identity: profile falls back to .provision-flags when agent.yaml predates profile_name', () => {
  const t = tree('agent_name: "heimdall"\npersona: |\n  x\n', 'AGENT_PROFILE=castor\nKEY_VAULT_NAME=x\n');
  assert.deepStrictEqual(cs.readIdentity(t), { agentName: 'heimdall', profileName: 'Castor' });
  fs.rmSync(t, { recursive: true, force: true });
});

test('identity: no agent.yaml -> nothing, and no fact is emitted', () => {
  const t = tree(null);
  assert.deepStrictEqual(cs.readIdentity(t), { agentName: null, profileName: null });
  assert.strictEqual(cs.identityFact(cs.readIdentity(t)), '');
  fs.rmSync(t, { recursive: true, force: true });
});

test('renderPersona: placeholders become the values; a persona without them is untouched', () => {
  const id = { agentName: 'probe', profileName: 'Keel' };
  assert.strictEqual(cs.renderPersona('You are {{AGENT_NAME}}, a {{ PROFILE_NAME }} agent.', id), 'You are probe, a Keel agent.');
  assert.strictEqual(cs.renderPersona('You are Keel.', id), 'You are Keel.');
  assert.strictEqual(cs.renderPersona('{{AGENT_NAME}}', {}), 'this agent');
});

test('the persona read from agent.yaml is rendered with the deploy-time name (override too)', () => {
  const t = tree('agent_name: "probe"\nprofile_name: "Keel"\npersona: |\n  You are {{AGENT_NAME}}. Always identify yourself as {{AGENT_NAME}}; {{PROFILE_NAME}} is your profile.\n');
  assert.match(cs.readPersona(t, null) || '', /^You are probe\. Always identify yourself as probe; Keel is your profile\./);
  const st = path.join(t, 'state'); fs.mkdirSync(st);
  cs.writePersona(st, 'Custom: I am {{AGENT_NAME}}.');
  assert.strictEqual(cs.readPersona(t, st), 'Custom: I am probe.');
  fs.rmSync(t, { recursive: true, force: true });
});

test('identityFact names the agent, marks the profile as role not name, and supersedes memory and transcript', () => {
  const f = cs.identityFact({ agentName: 'probe', profileName: 'Keel' });
  assert.match(f, /your name is "probe"/);
  assert.match(f, /Keel names your role and capabilities, not you/);
  assert.match(f, /supersedes any name given earlier in this conversation, in your memory, or in your persona text/);
  const g = cs.identityFact({ agentName: 'bosun', profileName: null });
  assert.match(g, /your name is "bosun"/);
  assert.doesNotMatch(g, /profile/);
});

test('the overlay wins: system/agent.local.yaml names the agent, agent.yaml keeps the profile default and profile_name', () => {
  const t = tree('agent_name: "Keel"\nprofile_name: "Keel"\npersona: |\n  You are {{AGENT_NAME}} ({{PROFILE_NAME}}).\n');
  fs.writeFileSync(path.join(t, 'system', 'agent.local.yaml'), '# written by cloud-init at provision\nagent_name: "probe"\n');
  assert.deepStrictEqual(cs.readIdentity(t), { agentName: 'probe', profileName: 'Keel' });
  assert.strictEqual(cs.readPersona(t, null), 'You are probe (Keel).');
  const auth = require('../../core/auth');
  assert.strictEqual(auth.readAgentName(t), 'probe');
  fs.rmSync(path.join(t, 'system', 'agent.local.yaml'));
  assert.strictEqual(auth.readAgentName(t), 'Keel');
  fs.rmSync(t, { recursive: true, force: true });
});

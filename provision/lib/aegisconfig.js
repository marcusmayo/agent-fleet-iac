'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runCapture } = require('./util');

// Resolve the path to aegis.config.json (the standalone Aegis console's registry).
// Order: explicit (--aegis-config) -> $AEGIS_CONFIG -> $AEGIS_DIR/aegis.config.json
//        -> <fleet-parent>/aegis/aegis.config.json (common sibling layout).
// Returns the first candidate that exists; if none exist, the first candidate so
// callers can create it. { path, exists } — path is null only if nothing to try.
function resolveConfigPath(explicit, fleetRoot) {
  const tries = [];
  if (explicit) tries.push(path.resolve(explicit));
  if (process.env.AEGIS_CONFIG) tries.push(path.resolve(process.env.AEGIS_CONFIG));
  if (process.env.AEGIS_DIR) tries.push(path.join(path.resolve(process.env.AEGIS_DIR), 'aegis.config.json'));
  if (fleetRoot) tries.push(path.join(path.dirname(fleetRoot), 'aegis', 'aegis.config.json'));

  for (const p of tries) if (fs.existsSync(p)) return { path: p, exists: true };
  return tries.length ? { path: tries[0], exists: false } : { path: null, exists: false };
}

// Is the config gitignored? Fail-closed: the only value that must block a write is
// 'not-ignored' (in a repo, trackable, NOT ignored). 'no-repo'/'no-git' can't be
// committed via git here, so they warn rather than block.
// -> { state: 'ignored' | 'not-ignored' | 'no-repo' | 'no-git', detail }
function gitignoreState(configPath) {
  const dir = path.dirname(configPath);
  const root = runCapture('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (root.notFound) return { state: 'no-git', detail: 'git not found on PATH' };
  if (!root.ok || !root.stdout) return { state: 'no-repo', detail: 'config is not inside a git repository' };
  const rel = path.relative(root.stdout, configPath) || path.basename(configPath);
  const chk = runCapture('git', ['-C', root.stdout, 'check-ignore', '--', rel]);
  if (chk.ok && chk.stdout) return { state: 'ignored', detail: `${rel} is gitignored` };
  return { state: 'not-ignored', detail: `${rel} is NOT gitignored in ${root.stdout}` };
}

function load(configPath) {
  if (!fs.existsSync(configPath)) return { agents: [] };
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch (e) { throw new Error(`cannot read ${configPath}: ${e.message}`); }
  if (raw.trim() === '') return { agents: [] };
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error(`aegis.config.json is not valid JSON: ${e.message}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('aegis.config.json must be a JSON object with an "agents" array');
  }
  if (!Array.isArray(data.agents)) throw new Error('aegis.config.json is missing its "agents" array');
  return data;
}

// Insert or replace the entry with a matching name. Never touches other agents.
// Returns 'added' | 'updated'.
function upsertAgent(data, entry) {
  const i = data.agents.findIndex((a) => a && a.name === entry.name);
  if (i >= 0) { data.agents[i] = { ...data.agents[i], ...entry }; return 'updated'; }
  data.agents.push(entry);
  return 'added';
}

function save(configPath, data) {
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

module.exports = { resolveConfigPath, gitignoreState, load, upsertAgent, save };

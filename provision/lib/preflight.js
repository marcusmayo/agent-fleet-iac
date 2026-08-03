'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCapture, which } = require('./util');

const PASS = 'pass';
const FAIL = 'fail';
const WARN = 'warn';

function azAccount() {
  if (!which('az')) return { level: FAIL, label: 'az CLI', detail: 'not found on PATH — install the Azure CLI' };
  const r = runCapture('az', ['account', 'show', '-o', 'json']);
  if (!r.ok) return { level: FAIL, label: 'az login', detail: 'az present but not logged in — run `az login`' };
  let sub = '(subscription info unavailable)';
  try {
    const j = JSON.parse(r.stdout);
    sub = `${j.name} (${j.id})`;
  } catch { /* keep default */ }
  return { level: PASS, label: 'az account', detail: sub };
}

function cfApiToken() {
  const t = process.env.CF_API_TOKEN;
  if (t && t.trim()) return { level: PASS, label: 'CF_API_TOKEN', detail: 'present (Zero Trust + DNS edit scope assumed)' };
  return { level: FAIL, label: 'CF_API_TOKEN', detail: 'not set — export the Cloudflare API token (ZT + DNS edit) before `up`' };
}

const looksLikeKey = (s) => /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-ssh-)/.test((s || '').trim());

// Returns { result, pubkey } — pubkey contents are handed to plan's what-if so the
// VM resource validates. Prefers $SSH_PUBKEY (contents), then a key file.
function sshPubkey() {
  const env = process.env.SSH_PUBKEY;
  if (env && looksLikeKey(env)) {
    return { result: { level: PASS, label: 'SSH public key', detail: 'from $SSH_PUBKEY' }, pubkey: env.trim() };
  }
  const file = process.env.AF_SSH_PUBKEY_FILE || path.join(os.homedir(), '.ssh', 'keel_t2.pub');
  if (fs.existsSync(file)) {
    let contents = '';
    try { contents = fs.readFileSync(file, 'utf8').trim(); } catch { /* ignore */ }
    if (looksLikeKey(contents)) return { result: { level: PASS, label: 'SSH public key', detail: file }, pubkey: contents };
    return { result: { level: WARN, label: 'SSH public key', detail: `${file} exists but is not a recognised public key` }, pubkey: null };
  }
  return {
    result: { level: FAIL, label: 'SSH public key', detail: `not found — set $SSH_PUBKEY or place a key at ${file} (override with $AF_SSH_PUBKEY_FILE)` },
    pubkey: null,
  };
}

function paramFile(root, profile) {
  const rel = path.posix.join('bicep', 'params', `${profile}.bicepparam`);
  return fs.existsSync(path.join(root, 'bicep', 'params', `${profile}.bicepparam`))
    ? { level: PASS, label: 'bicepparam', detail: rel }
    : { level: FAIL, label: 'bicepparam', detail: `${rel} missing` };
}

function mainBicep(root) {
  return fs.existsSync(path.join(root, 'bicep', 'main.bicep'))
    ? { level: PASS, label: 'main.bicep', detail: 'bicep/main.bicep' }
    : { level: FAIL, label: 'main.bicep', detail: 'bicep/main.bicep missing' };
}

function chainScripts(root) {
  const need = ['scripts/deploy.sh', 'scripts/cloudflare-provision.ps1'];
  const missing = need.filter((f) => !fs.existsSync(path.join(root, ...f.split('/'))));
  return missing.length
    ? { level: WARN, label: 'chain scripts', detail: `missing: ${missing.join(', ')}` }
    : { level: PASS, label: 'chain scripts', detail: need.join(', ') };
}

// Castor only — the KV Secrets Officer grant needs the deployer's AAD object id.
function deployerObjectId() {
  const env = process.env.DEPLOYER_OBJECT_ID;
  if (env && env.trim()) return { level: PASS, label: 'deployer object id', detail: 'from $DEPLOYER_OBJECT_ID' };
  if (!which('az')) return { level: WARN, label: 'deployer object id', detail: 'az absent — set $DEPLOYER_OBJECT_ID or grant KV Secrets Officer manually' };
  const r = runCapture('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']);
  if (r.ok && r.stdout) return { level: PASS, label: 'deployer object id', detail: `resolves to ${r.stdout} at deploy` };
  return { level: WARN, label: 'deployer object id', detail: 'not set and not resolvable now; KV Secrets Officer grant will be skipped (grant manually if needed)' };
}

module.exports = {
  azAccount, cfApiToken, sshPubkey, paramFile, mainBicep, chainScripts, deployerObjectId,
  PASS, FAIL, WARN,
};

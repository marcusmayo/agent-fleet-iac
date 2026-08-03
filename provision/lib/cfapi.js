'use strict';
// Cloudflare API calls for the Aegis service token + its Service Auth policy —
// the one piece cloudflare-provision.ps1 does NOT do. Same endpoints/shape the PS
// script uses for the operator policy, so there's no second contract.
//
// Split into pure request builders (req*) and thin executors so the construction
// is unit-testable without any live call. Secrets never pass through here except
// the client_secret returned by createServiceToken, which the caller writes only
// to the gitignored config.

const CF_API = 'https://api.cloudflare.com/client/v4';

function reqCreateServiceToken(accountId, name) {
  return { method: 'POST', url: `${CF_API}/accounts/${accountId}/access/service_tokens`, body: { name } };
}
function reqListServiceTokens(accountId) {
  return { method: 'GET', url: `${CF_API}/accounts/${accountId}/access/service_tokens` };
}
function reqDeleteServiceToken(accountId, id) {
  return { method: 'DELETE', url: `${CF_API}/accounts/${accountId}/access/service_tokens/${id}` };
}
function reqListApps(accountId) {
  return { method: 'GET', url: `${CF_API}/accounts/${accountId}/access/apps` };
}
function reqListPolicies(accountId, appId) {
  return { method: 'GET', url: `${CF_API}/accounts/${accountId}/access/apps/${appId}/policies` };
}
// Service Auth policy: decision MUST be non_identity or Access prompts for IdP login.
function reqServiceAuthPolicy(accountId, appId, policyName, tokenId, existingPolicyId) {
  const body = {
    name: policyName,
    decision: 'non_identity',
    include: [{ service_token: { token_id: tokenId } }],
  };
  const base = `${CF_API}/accounts/${accountId}/access/apps/${appId}/policies`;
  return existingPolicyId
    ? { method: 'PUT', url: `${base}/${existingPolicyId}`, body }
    : { method: 'POST', url: base, body };
}

async function cfExec(req, apiToken) {
  const res = await fetch(req.url, {
    method: req.method,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: req.body ? JSON.stringify(req.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || !json || json.success === false) {
    const errs = json && Array.isArray(json.errors) && json.errors.length
      ? json.errors.map((e) => `${e.code}: ${e.message}`).join('; ')
      : `HTTP ${res.status}`;
    throw new Error(`CF API ${req.method} ${req.url.replace(CF_API, '')} failed: ${errs}`);
  }
  return json.result;
}

async function createServiceToken(accountId, name, apiToken) {
  const r = await cfExec(reqCreateServiceToken(accountId, name), apiToken);
  return { id: r.id, clientId: r.client_id, clientSecret: r.client_secret };
}

async function findServiceTokenByName(accountId, name, apiToken) {
  const toks = await cfExec(reqListServiceTokens(accountId), apiToken);
  return (toks || []).find((t) => t.name === name) || null;
}

async function deleteServiceToken(accountId, id, apiToken) {
  await cfExec(reqDeleteServiceToken(accountId, id), apiToken);
}

async function findAppByHostname(accountId, hostname, apiToken) {
  const apps = await cfExec(reqListApps(accountId), apiToken);
  return (apps || []).find((a) => a.domain === hostname) || null;
}

// Create or update (idempotent by name) the Service Auth policy on the app.
async function upsertServiceAuthPolicy(accountId, appId, policyName, tokenId, apiToken) {
  const policies = await cfExec(reqListPolicies(accountId, appId), apiToken);
  const existing = (policies || []).find((p) => p.name === policyName);
  await cfExec(reqServiceAuthPolicy(accountId, appId, policyName, tokenId, existing && existing.id), apiToken);
  return existing ? 'updated' : 'created';
}

module.exports = {
  CF_API,
  reqCreateServiceToken, reqListServiceTokens, reqDeleteServiceToken,
  reqListApps, reqListPolicies, reqServiceAuthPolicy,
  cfExec, createServiceToken, findServiceTokenByName, deleteServiceToken,
  findAppByHostname, upsertServiceAuthPolicy,
};

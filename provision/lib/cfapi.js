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
// Rotate: new client_secret on the SAME token id — policy references stay valid.
function reqRotateServiceToken(accountId, id) {
  return { method: 'POST', url: `${CF_API}/accounts/${accountId}/access/service_tokens/${id}/rotate` };
}
function reqListApps(accountId) {
  return { method: 'GET', url: `${CF_API}/accounts/${accountId}/access/apps` };
}
// Account-level REUSABLE policies (distinct from per-app policies below): the hand-built
// agents used these, and they survive app deletion -- decommission sweeps the leftovers.
function reqListReusablePolicies(accountId) {
  return { method: 'GET', url: `${CF_API}/accounts/${accountId}/access/policies?per_page=100` };
}
function reqDeleteReusablePolicy(accountId, id) {
  return { method: 'DELETE', url: `${CF_API}/accounts/${accountId}/access/policies/${id}` };
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

async function listServiceTokens(accountId, apiToken) {
  return (await cfExec(reqListServiceTokens(accountId), apiToken)) || [];
}

async function listAppPolicies(accountId, appId, apiToken) {
  return (await cfExec(reqListPolicies(accountId, appId), apiToken)) || [];
}

async function deleteServiceToken(accountId, id, apiToken) {
  await cfExec(reqDeleteServiceToken(accountId, id), apiToken);
}

async function rotateServiceToken(accountId, id, apiToken) {
  const r = await cfExec(reqRotateServiceToken(accountId, id), apiToken);
  return { id: r.id, clientId: r.client_id, clientSecret: r.client_secret };
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

// --- Decommission (reverse-of-provision) --------------------------------------
// The tunnel, DNS CNAME, and Access app are CREATED by cloudflare-provision.ps1;
// the service token already had create/find/delete here. Deletes hit the same
// endpoints the PS script + this module use to create, so there's no new contract.
function reqListTunnels(accountId, name) {
  return { method: 'GET', url: `${CF_API}/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}` };
}
function reqDeleteTunnel(accountId, id) {
  return { method: 'DELETE', url: `${CF_API}/accounts/${accountId}/cfd_tunnel/${id}` };
}
function reqDeleteTunnelConnections(accountId, id) {
  return { method: 'DELETE', url: `${CF_API}/accounts/${accountId}/cfd_tunnel/${id}/connections` };
}
function reqListZones(name) {
  return { method: 'GET', url: `${CF_API}/zones?name=${encodeURIComponent(name)}` };
}
function reqListDnsRecords(zoneId, name) {
  return { method: 'GET', url: `${CF_API}/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}` };
}
function reqDeleteDnsRecord(zoneId, id) {
  return { method: 'DELETE', url: `${CF_API}/zones/${zoneId}/dns_records/${id}` };
}
function reqDeleteApp(accountId, id) {
  return { method: 'DELETE', url: `${CF_API}/accounts/${accountId}/access/apps/${id}` };
}

async function findTunnelByName(accountId, name, apiToken) {
  const tuns = await cfExec(reqListTunnels(accountId, name), apiToken);
  return (tuns || []).find((t) => t.name === name && !t.deleted_at) || null;
}
async function deleteTunnel(accountId, id, apiToken) {
  // A tunnel with live connections refuses deletion; clean stale connections first
  // (no-op if none — the RG/VM should already be gone), then delete the tunnel.
  try { await cfExec(reqDeleteTunnelConnections(accountId, id), apiToken); } catch { /* none to clean */ }
  await cfExec(reqDeleteTunnel(accountId, id), apiToken);
}
async function findZoneIdByName(name, apiToken) {
  const zones = await cfExec(reqListZones(name), apiToken);
  const z = (zones || []).find((zz) => zz.name === name) || (zones || [])[0];
  return z ? z.id : null;
}
async function findDnsRecordByHostname(zoneId, hostname, apiToken) {
  const recs = await cfExec(reqListDnsRecords(zoneId, hostname), apiToken);
  return (recs || []).find((r) => r.type === 'CNAME' && r.name === hostname) || null;
}
async function deleteDnsRecord(zoneId, id, apiToken) {
  await cfExec(reqDeleteDnsRecord(zoneId, id), apiToken);
}
async function deleteApp(accountId, id, apiToken) {
  await cfExec(reqDeleteApp(accountId, id), apiToken);
}
async function listReusablePolicies(accountId, apiToken) {
  return (await cfExec(reqListReusablePolicies(accountId), apiToken)) || [];
}
async function deleteReusablePolicy(accountId, id, apiToken) {
  await cfExec(reqDeleteReusablePolicy(accountId, id), apiToken);
}

module.exports = {
  CF_API,
  reqCreateServiceToken, reqListServiceTokens, reqDeleteServiceToken, reqRotateServiceToken,
  reqListApps, reqListPolicies, reqServiceAuthPolicy,
  reqListTunnels, reqDeleteTunnel, reqDeleteTunnelConnections,
  reqListZones, reqListDnsRecords, reqDeleteDnsRecord, reqDeleteApp,
  cfExec, createServiceToken, findServiceTokenByName, listServiceTokens, listAppPolicies, deleteServiceToken, rotateServiceToken,
  findAppByHostname, upsertServiceAuthPolicy,
  findTunnelByName, deleteTunnel, findZoneIdByName, findDnsRecordByHostname, deleteDnsRecord, deleteApp,
  listReusablePolicies,
  deleteReusablePolicy,
};

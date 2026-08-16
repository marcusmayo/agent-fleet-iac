'use strict';
// enroll.js — adopt an already-provisioned agent into THIS control plane, with its own token.
//
// WHY ITS OWN TOKEN. An agent's audit chain records the caller as the service token's
// client id. Two control planes sharing one token are therefore indistinguishable in the
// record. One token per (plane, agent) means an agent's chain can tell the hosted plane
// from the break-glass workstation, and rotating one plane's credentials never touches
// the other. The token is named "<plane>-<agent>" (plane = $AEGIS_PLANE, else hostname).
//
// NOTHING TYPED. The agent's identity comes from Azure -- rg-<name> tags written by the
// provisioning template (app=agent-fleet, agent=<name>, profile=<profile>) -- so a name
// that is not a fleet agent (the control plane's own RG carries role=control-plane and no
// profile) is refused, not enrolled. Its Access app is looked up by hostname. The token
// is minted by Cloudflare and written straight into aegis.config.json (gitignored --
// refused if it is not), and is never printed. The Service Auth policy on the agent's app
// is upserted by name. Attested per agent, ledgered, and idempotent:
//   no token                       -> create, policy, register     outcome: ok (created)
//   token + registry has its id     -> nothing                      outcome: ok (no-op: enrolled)
//   token, registry lacks it        -> rotate (a secret cannot be re-read), policy, register
//                                                                    outcome: ok (rotated)
// The ledger record carries the client id, never the secret.
const os = require('os');
const { c: col, runCapture, which, findFleetRoot } = require('./util');
const cf = require('./cfapi');
const cfg = require('./aegisconfig');
const { resolvePolicyPath, ledger } = require('./policy');
const { DEFAULT_DOMAIN } = require('./contract');

const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;

function planeName(explicit) {
  const raw = (explicit || process.env.AEGIS_PLANE || os.hostname() || 'aegis').toLowerCase();
  return raw.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'aegis';
}
function attestSentence(agent, plane) {
  return 'I approve enrolling ' + agent + ' in the control plane ' + plane;
}

// Pure: what the RG tags say this name is. Exported for tests.
function agentIdentity(tags, agent) {
  const t = tags || {};
  if (t.role === 'control-plane') return { ok: false, why: 'rg-' + agent + ' is a control plane (role=control-plane), not an agent' };
  if (t.app !== 'agent-fleet') return { ok: false, why: 'rg-' + agent + ' is not tagged app=agent-fleet' };
  if (t.agent !== agent) return { ok: false, why: 'rg-' + agent + ' is tagged agent=' + JSON.stringify(t.agent || null) + ', expected ' + JSON.stringify(agent) };
  if (!t.profile || typeof t.profile !== 'string') return { ok: false, why: 'rg-' + agent + ' carries no profile tag' };
  return { ok: true, profile: t.profile };
}

// Pure: what to do given the CF token state and the registry entry. Exported for tests.
function decideAction(existingToken, entry) {
  if (!existingToken) return 'create';
  if (entry && entry.clientId && existingToken.client_id && entry.clientId === existingToken.client_id) return 'noop';
  return 'rotate';
}

async function gather(agent, opts) {
  const plane = planeName(opts.plane);
  const domain = (opts.domain || DEFAULT_DOMAIN).trim();
  const R = {
    az: which('az'), plane, domain,
    tokenName: plane + '-' + agent,
    host: agent + '.' + domain,
    cfToken: (process.env.CF_API_TOKEN || '').trim(),
    accountId: (process.env.CF_ACCOUNT_ID || '').trim(),
    identity: { ok: false, why: 'rg-' + agent + ' unreadable' },
    token: null, tokenErr: '', app: null, appErr: '',
    configPath: null, configExists: false, gi: null, data: null, entry: null, dataErr: '',
  };
  const rg = runCapture('az', ['group', 'show', '-n', 'rg-' + agent, '-o', 'json']);
  if (rg.ok) {
    try { R.identity = agentIdentity(JSON.parse(rg.stdout || '{}').tags, agent); } catch { R.identity = { ok: false, why: 'rg-' + agent + ' unreadable (bad json)' }; }
  } else {
    R.identity = { ok: false, why: 'rg-' + agent + ' unreadable: ' + ((rg.stderr || 'az group show failed').split('\n')[0]) };
  }
  const { path: p, exists } = cfg.resolveConfigPath(opts.aegisConfig, findFleetRoot());
  R.configPath = p; R.configExists = exists;
  if (p) {
    R.gi = cfg.gitignoreState(p);
    try { R.data = cfg.load(p); R.entry = R.data.agents.find((a) => a && a.name === agent) || null; }
    catch (e) { R.dataErr = e.message; }
  }
  if (R.cfToken && /^[0-9a-f]{32}$/.test(R.accountId)) {
    try { R.token = await cf.findServiceTokenByName(R.accountId, R.tokenName, R.cfToken); } catch (e) { R.tokenErr = e.message; }
    try { R.app = await cf.findAppByHostname(R.accountId, R.host, R.cfToken); } catch (e) { R.appErr = e.message; }
  }
  return R;
}

function printPlan(agent, R, required) {
  console.log(col.bold('\nENROLL — ' + agent + ' into control plane ' + R.plane));
  console.log('  agent identity  ' + (R.identity.ok ? col.green('rg-' + agent + '  profile ' + R.identity.profile) + col.dim('  (from Azure tags)') : col.red('REFUSED: ' + R.identity.why)));
  console.log('  host / app      ' + R.host + '  ->  ' + (R.app ? col.green('Access app ' + R.app.id) : (R.appErr ? col.red('unreadable: ' + R.appErr) : (R.cfToken ? col.red('NO ACCESS APP') : col.yellow('not checked (CF creds absent)')))));
  console.log('  service token   ' + R.tokenName + '  ->  ' + (R.token ? col.green('exists (' + R.token.client_id + ')') : (R.tokenErr ? col.red('unreadable: ' + R.tokenErr) : (R.cfToken ? 'absent (will be created)' : col.yellow('not checked (CF creds absent)')))));
  console.log('  registry        ' + (R.configPath ? R.configPath : col.red('unresolved')) + (R.gi ? col.dim('  (' + R.gi.state + ')') : '') + (R.entry ? col.dim('  entry present: ' + (R.entry.clientId || '?')) : col.dim('  no entry')));
  const act = R.cfToken ? decideAction(R.token, R.entry) : '?';
  console.log('  action          ' + (act === 'noop' ? col.green('none — already enrolled') : act === 'create' ? 'create token → policy → register' : act === 'rotate' ? col.yellow('rotate token (secret cannot be re-read) → policy → register') : col.dim('unknown until CF creds are present')));
  console.log('  attestation     ' + col.dim(required));
  console.log(col.dim('  the client secret is written to the registry only; it is never printed and never ledgered'));
}

async function runEnroll(agent, opts = {}) {
  console.log(col.cyan('enroll ' + (agent || '?') + (opts.go ? ' --go' : ' (plan)')));
  if (!agent || !NAME_RE.test(agent)) { console.log(col.red('\nenroll: agent name must match ' + NAME_RE)); return 2; }
  const R = await gather(agent, opts);
  const required = attestSentence(agent, R.plane);
  printPlan(agent, R, required);
  if (!opts.go) {
    console.log(col.yellow('\nplan only — nothing was created. Re-run with --go --attest "' + required + '" to execute.'));
    return 0;
  }

  const policyPath = resolvePolicyPath();
  const base = { action: 'aegis.enroll', key: agent, plane: R.plane, tokenName: R.tokenName, host: R.host };
  const led = (extra) => { try { return policyPath ? ledger(policyPath, { ...base, ...extra }) : null; } catch { return null; } };

  if ((opts.attest || '').trim() !== required) {
    led({ phrase: opts.attest || '', outcome: 'refused: attestation mismatch' });
    console.log(col.red('\nenroll --go REFUSED — attestation must read exactly:'));
    console.log('  ' + required);
    return 3;
  }
  // Can'ts, in the order an operator can act on them.
  const refuse = (why) => { led({ phrase: opts.attest, outcome: 'refused: ' + why }); console.log(col.red('\nenroll --go REFUSED (nothing changed) — ' + why)); return 2; };
  if (!R.identity.ok) return refuse(R.identity.why);
  if (!R.cfToken || !/^[0-9a-f]{32}$/.test(R.accountId)) return refuse('CF_API_TOKEN / CF_ACCOUNT_ID not in env');
  if (R.tokenErr) return refuse('service tokens unreadable: ' + R.tokenErr);
  if (R.appErr) return refuse('Access apps unreadable: ' + R.appErr);
  if (!R.app) return refuse('no Access app for ' + R.host + ' — the agent front door must exist first');
  if (!R.configPath) return refuse('aegis.config.json unresolved (set $AEGIS_CONFIG or --aegis-config=<path>)');
  if (R.dataErr) return refuse('registry: ' + R.dataErr);
  if (R.gi && R.gi.state === 'not-ignored') return refuse(R.gi.detail + ' — the registry holds secrets');

  const action = decideAction(R.token, R.entry);
  if (action === 'noop') {
    led({ phrase: opts.attest, clientId: R.token.client_id, outcome: 'ok (no-op: enrolled)' });
    console.log(col.green('\nalready enrolled — no-op, ledgered.'));
    return 0;
  }
  let creds;
  try {
    creds = action === 'create'
      ? await cf.createServiceToken(R.accountId, R.tokenName, R.cfToken)
      : await cf.rotateServiceToken(R.accountId, R.token.id, R.cfToken);
  } catch (e) {
    led({ phrase: opts.attest, outcome: 'failed: token ' + action + ': ' + e.message });
    console.log(col.red('\nenroll FAILED (ledgered): token ' + action + ': ' + e.message));
    return 1;
  }
  let policyAction;
  try {
    policyAction = await cf.upsertServiceAuthPolicy(R.accountId, R.app.id, R.tokenName, creds.id, R.cfToken);
  } catch (e) {
    led({ phrase: opts.attest, clientId: creds.clientId, outcome: 'failed: policy: ' + e.message + ' (token ' + action + 'd, NOT registered)' });
    console.log(col.red('\nenroll FAILED (ledgered): Service Auth policy: ' + e.message));
    return 1;
  }
  const data = R.data || { agents: [] };
  const regAction = cfg.upsertAgent(data, { name: agent, profile: R.identity.profile, host: R.host, clientId: creds.clientId, clientSecret: creds.clientSecret });
  try { cfg.save(R.configPath, data); }
  catch (e) {
    led({ phrase: opts.attest, clientId: creds.clientId, outcome: 'failed: registry write: ' + e.message });
    console.log(col.red('\nenroll FAILED (ledgered): registry write: ' + e.message));
    return 1;
  }
  const rec = led({ phrase: opts.attest, clientId: creds.clientId, profile: R.identity.profile, policy: policyAction, registry: regAction, outcome: 'ok (' + action + 'd)' });
  console.log(col.green('\nenrolled ' + agent + ' — token ' + action + 'd, policy ' + policyAction + ', registry ' + regAction) + col.dim('  (ledgered ' + (rec ? 'ok' : 'NO — policy-audit path unresolved') + ')'));
  console.log('  clientId      ' + creds.clientId + col.dim('   (the agent will record this id as the actor; label it in system/agent.yaml actor_labels as "' + R.plane + '")'));
  console.log(col.dim('  agents now registered: ' + data.agents.map((a) => a.name).join(', ')));
  return 0;
}

module.exports = { runEnroll, agentIdentity, decideAction, attestSentence, planeName };

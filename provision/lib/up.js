'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { c, findFleetRoot, which, resolveBash, runCapture } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const pf = require('./preflight');
const cf = require('./cfapi');
const cfg = require('./aegisconfig');
const policy = require('./policy');
const budget = require('./budget');
const { checkCapacity } = require('./capacity');
const { runRegister } = require('./register');
const backup = require('./backup');

const bad = (s) => !s || /[<>]/.test(s);                  // empty, or still a <placeholder>
const SET = (x) => (x ? (/[<>]/.test(x) ? c.red('placeholder <…>') : c.green('set')) : c.red('MISSING'));

// Resolve a PowerShell that actually launches. On Windows, prefer real Windows
// PowerShell over the pwsh App-Execution-Alias stub in WindowsApps (which `where`
// finds but which fails with "cannot find the file specified" when PS7 isn't installed).
function resolvePwsh() {
  return process.platform === 'win32'
    ? (which('powershell') || which('pwsh'))
    : (which('pwsh') || which('powershell'));
}

function gather(v, opts) {
  const d = derive(v);
  const fleetRoot = findFleetRoot();
  const sk = pf.sshPubkey();
  const { path: configPath } = cfg.resolveConfigPath(opts.aegisConfig, fleetRoot);
  const gi = configPath ? cfg.gitignoreState(configPath) : { state: 'no-repo', detail: '' };

  let pol;
  try { pol = policy.loadPolicy(opts.policy); }
  catch (e) { pol = { ...policy.DEFAULTS, source: '(error: ' + e.message + ')' }; }
  let fleet = [];
  try { if (configPath && fs.existsSync(configPath)) fleet = cfg.load(configPath).agents.map((a) => a.name); }
  catch { /* unreadable config -> treat as empty fleet; register step will surface real errors */ }

  return {
    d, fleetRoot, configPath, giState: gi.state,
    pol, fleet,
    pubkey: sk.pubkey,
    pwsh: resolvePwsh(),
    bash: resolveBash(),
    az: which('az'),
    // Azure capacity: offered SKU + family/regional quota headroom, read here so a refusal
    // happens in plan and names the quota to request (see capacity.js; found on the aegis lane).
    capacity: checkCapacity(v.region, d.azure.vmSize),
    cfToken: process.env.CF_API_TOKEN || '',
    accountId: process.env.CF_ACCOUNT_ID || '',
    operatorEmail: (v.operatorEmail || process.env.CF_OPERATOR_EMAIL || '').trim(),   // contract field wins (per-agent)
  };
}

function printPlan(v, R) {
  const d = R.d;
  console.log(c.bold(`\nBring up "${v.name}" (${v.profile}) at ${d.cloudflare.fqdn}`));
  console.log(c.dim('Order is cheap/reversible first; the VM — the only billable step — is last.\n'));

  console.log(c.bold('0. preflight'));
  console.log(`     CF_API_TOKEN        ${SET(R.cfToken)}`);
  console.log(`     CF_ACCOUNT_ID       ${SET(R.accountId)}`);
  console.log(`     CF_OPERATOR_EMAIL   ${R.operatorEmail ? (/[<>]/.test(R.operatorEmail) ? c.red(R.operatorEmail + '  (placeholder)') : R.operatorEmail) : c.red('MISSING')}`);
  console.log(`     SSH public key      ${R.pubkey ? c.green('resolved') : c.red('MISSING (set $SSH_PUBKEY or $AF_SSH_PUBKEY_FILE)')}`);
  console.log(`     pwsh / bash / az    ${R.pwsh ? c.green('pwsh') : c.red('no pwsh')} / ${R.bash ? c.green('bash') : c.red('no bash')} / ${R.az ? c.green('az') : c.red('no az')}`);
  console.log(`     aegis.config.json   ${R.configPath || c.red('unresolved')} ${R.configPath ? c.dim('(' + R.giState + ')') : ''}`);

  console.log(c.bold('\n1. Cloudflare front door') + c.dim('  (scripts/cloudflare-provision.ps1 — creates/reuses tunnel, DNS, app, operator policy)'));
  console.log(`     pwsh -File scripts/cloudflare-provision.ps1 -AgentName ${v.name} -OperatorEmail ${R.operatorEmail || '<email>'} \\`);
  console.log(`          -AccountId ${c.dim('••••')} -Domain ${v.domain} -AgentProfile ${v.profile} -WebchatPort ${v.webchatPort}`);
  console.log(c.dim(`     -> tunnel "${v.name}", DNS ${d.cloudflare.fqdn}, app "${v.name}", policy ${v.name}-operator; tunnel token captured (redacted)`));

  console.log(c.bold('\n2. Service token') + c.dim('  (Cloudflare API)'));
  console.log(`     POST /accounts/{acct}/access/service_tokens   { "name": "aegis-${v.name}" }`);
  console.log(c.dim('     -> client_id + client_secret (secret written ONLY to aegis.config.json, never printed)'));

  console.log(c.bold('\n3. Service Auth policy') + c.dim('  (Cloudflare API)'));
  console.log(`     find app by domain ${d.cloudflare.fqdn} -> app_id`);
  console.log(`     POST /accounts/{acct}/access/apps/{app_id}/policies`);
  console.log(`          { "name": "aegis-${v.name}", "decision": "non_identity", "include": [{ "service_token": { "token_id": … } }] }`);

  console.log(c.bold('\n4. Register') + c.dim('  (local, idempotent)'));
  console.log(`     upsert { name: ${v.name}, profile: ${v.profile}, host: ${d.cloudflare.fqdn}, clientId, clientSecret } into aegis.config.json`);

  console.log(c.bold('\n5. Deploy the VM') + c.red('  — BILLABLE') + c.dim('  (scripts/deploy.sh)'));
  console.log(`     bash scripts/deploy.sh ${v.profile} ${v.name}   ${c.dim('(env: CF_TUNNEL_TOKEN, SSH_PUBKEY, SSH_CIDR, REPO_*)')}`);
  console.log(c.dim(`     -> az deployment sub create -> ${d.azure.resourceGroup} + ${d.azure.vmName}${v.profile === 'castor' ? ' + vault/identity/backup' : ''}`));

  console.log(c.bold('\nAfter up') + c.dim('  (cloud-init builds + brands ~4-8 min, then WAITS for its vault seed):'));
  console.log(c.dim(`     fleetctl set-secrets ${v.name}                                 (seed vault; VM self-configures, no SSH)`));
  console.log(c.dim(`     fleetctl check agents/${v.name}.agent.jsonc --live                    (expect HTTP 200)`));

  const gate = policy.checkProvision(R.pol, { currentFleet: R.fleet, names: [v.name], region: v.region });
  const regionOk = Array.isArray(R.pol.allowedRegions) && R.pol.allowedRegions.includes(v.region);
  console.log(c.bold('\nPolicy  ') + c.dim('(structural caps — enforced at --go, fail-closed)'));
  console.log(`  caps            maxFleet ${R.pol.maxFleet} · maxBatch ${R.pol.maxBatch} · budget $${R.pol.maxMonthlyBudgetUsd}/mo (enforced at --go vs Azure budget "${R.pol.budgetName}")`);
  console.log(`  fleet           ${R.fleet.length}/${R.pol.maxFleet} registered${R.fleet.length ? '  (' + R.fleet.join(', ') + ')' : ''}`);
  console.log(`  region          ${v.region} ${regionOk ? c.green('(allowed)') : c.red('NOT allowed — allowedRegions: ' + (R.pol.allowedRegions || []).join(', '))}`);
  console.log(`  gate            ${gate.ok ? c.green('PASS') : c.red('BLOCK — ' + gate.errors.join('; '))}`);
  console.log(`  capacity        ${R.capacity.ok ? c.green('PASS') : c.red('FAIL')} ${c.dim(d.azure.vmSize + ' in ' + v.region + ' — ' + R.capacity.detail)}`);
  if (!R.capacity.ok && R.capacity.request) console.log(c.dim('                  request: ') + R.capacity.request);
  console.log(c.dim(`  policy          ${R.pol.source}`));
}

// Deterministic deploy env. The contract has already resolved every value
// (including the per-profile repo default), so pass them all EXPLICITLY.
// Never pass a meaningful key as '' — readEnvironmentVariable() in the
// bicepparams treats a present-but-empty env var as a value and skips its
// default (that produced `git clone ''` in cloud-init). Exported for tests.
function deployEnv(v, pubkey, tunnelToken) {
  return {
    CF_TUNNEL_TOKEN: tunnelToken,
    SSH_PUBKEY: pubkey,
    SSH_CIDR: v.sshCidr || '',
    AZ_LOCATION: v.region,
    REPO_URL: v.repoUrl,          // always the resolved value — never ''
    REPO_REF: v.repoRef || '',    // '' equals the bicepparam default (HEAD)
  };
}

// Run a script inheriting stdio so the operator sees progress. Spawns the resolved
// executable path directly (no shell) — avoids the shell-args deprecation warning and
// handles exe paths with spaces. Returns true on success.
function runScript(exe, args, opts = {}) {
  console.log(c.dim(`\n$ ${exe} ${args.join(' ')}`));
  const r = spawnSync(exe, args, {
    stdio: 'inherit',
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return !r.error && r.status === 0;
}

async function runUp(file, opts = {}) {
  console.log(c.cyan(`up${opts.go ? ' --go' : ' (plan)'}  ${file}`));
  const res = loadContract(file);
  if (!res.ok) {
    console.log(c.red('\nContract INVALID:'));
    for (const e of res.errors) console.log('  - ' + e);
    return 1;
  }
  const v = res.value;
  const R = gather(v, opts);
  printPlan(v, R);

  if (!opts.go) {
    console.log(c.yellow('\nplan only — nothing was created. Re-run with --go to execute.'));
    return 0;
  }

  // --- fail-fast preflight before touching anything ---
  const missing = [];
  if (!R.cfToken) missing.push('$CF_API_TOKEN');
  if (!R.accountId) missing.push('$CF_ACCOUNT_ID');
  if (!R.operatorEmail) missing.push('$CF_OPERATOR_EMAIL');
  if (!R.pubkey) missing.push('SSH public key');
  if (!R.pwsh) missing.push('pwsh/powershell');
  if (!R.bash) missing.push('bash');
  if (!R.az) missing.push('az');
  if (!R.fleetRoot) missing.push('fleet root (bicep/main.bicep + scripts/deploy.sh)');
  if (!R.configPath) missing.push('aegis.config.json path');
  const placeholders = [];
  if (R.cfToken && /[<>]/.test(R.cfToken)) placeholders.push('CF_API_TOKEN');
  if (R.accountId && /[<>]/.test(R.accountId)) placeholders.push('CF_ACCOUNT_ID');
  if (R.operatorEmail && /[<>]/.test(R.operatorEmail)) placeholders.push('CF_OPERATOR_EMAIL');
  if (placeholders.length) {
    console.log(c.red(`\nup --go ABORT (nothing created) — these env vars still hold <placeholder> text: $${placeholders.join(', $')}`));
    console.log('  Set them to the real values (no angle brackets), then re-run.');
    return 2;
  }
  if (missing.length) {
    console.log(c.red(`\nup --go ABORT (nothing created) — missing: ${missing.join(', ')}`));
    return 2;
  }
  if (R.giState === 'not-ignored') {
    console.log(c.red(`\nup --go ABORT — aegis.config.json is not gitignored; refusing to write a secret to a trackable file.`));
    return 1;
  }

  // Structural policy gate (maxFleet, maxBatch, region allowlist) — fail-closed,
  // before anything is created. This is the account-protection layer.
  const gate = policy.checkProvision(R.pol, { currentFleet: R.fleet, names: [v.name], region: v.region });
  if (!gate.ok) {
    console.log(c.red('\nup --go ABORT (nothing created) — blocked by fleet policy:'));
    for (const e of gate.errors) console.log('  - ' + e);
    console.log(c.dim(`  policy: ${R.pol.source}`));
    return 2;
  }

  // Budget gate: refuse if month-to-date actual spend already meets/exceeds the
  // declared budget. Unreadable spend warns (maxFleet still bounds count).
  const bgate = budget.checkBudget(R.pol.maxMonthlyBudgetUsd, budget.readBudgetSpend(R.pol.budgetName));
  console.log((bgate.warn ? c.yellow : c.dim)('\nbudget: ' + bgate.message));
  if (!bgate.ok) {
    console.log(c.red('\nup --go ABORT (nothing created) — over the monthly budget.'));
    console.log(c.dim('  Raise maxMonthlyBudgetUsd in aegis.policy.jsonc, or wait for the next billing cycle.'));
    return 2;
  }
  // Capacity: an Azure Can't the lane sees before ARM does -- offered is not permitted.
  if (!R.capacity.ok) {
    console.log(c.red('\nup --go ABORT (nothing created) — capacity: ' + R.capacity.detail));
    if (R.capacity.request) console.log('  request it: ' + R.capacity.request);
    return 2;
  }

  // Rebuild guard: a VM's cloud-init (osProfile.customData) is IMMUTABLE after
  // creation, so deploying changed cloud-init onto an existing VM fails with
  // PropertyChangeNotAllowed. If the agent's RG already exists, stop before
  // touching anything and say so. --update overrides for intentional in-place
  // updates that don't change customData.
  const rgProbe = runCapture('az', ['group', 'exists', '-n', R.d.azure.resourceGroup]);
  if (rgProbe.ok && rgProbe.stdout.trim() === 'true' && !opts.update) {
    console.log(c.red(`\nup --go ABORT (nothing created) — resource group ${R.d.azure.resourceGroup} already exists.`));
    console.log(`  A VM's cloud-init (customData) is immutable, so a redeploy with changed cloud-init fails.`);
    console.log(`  For a rebuild:   az group delete --name ${R.d.azure.resourceGroup} --yes     (blocks until deleted)`);
    console.log(`  then verify:     az group exists -n ${R.d.azure.resourceGroup}      (must print: false)`);
    console.log(`  and re-run. For an intentional in-place update that does not change cloud-init: add --update.`);
    return 2;
  }

  const psScript = path.join(R.fleetRoot, 'scripts', 'cloudflare-provision.ps1');
  const tokenFile = path.join(os.tmpdir(), `cf-tunnel-${v.name}-${Date.now()}.txt`);
  const step = (n, msg) => console.log(c.bold(`\n[${n}/5] ${msg}`));

  try {
    // 1. Cloudflare front door
    step(1, 'Cloudflare front door (tunnel, DNS, app, operator policy)');
    const ok1 = runScript(R.pwsh, ['-File', psScript,
      '-AgentName', v.name, '-OperatorEmail', R.operatorEmail, '-AccountId', R.accountId,
      '-Domain', v.domain, '-AgentProfile', v.profile, '-WebchatPort', String(v.webchatPort),
      '-TokenOutFile', tokenFile,
    ], { cwd: R.fleetRoot });
    if (!ok1) { console.log(c.red('\nStep 1 failed (cloudflare-provision.ps1). Nothing billable created.')); return 1; }
    let tunnelToken = '';
    try { tunnelToken = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* handled below */ }
    if (!tunnelToken) { console.log(c.red(`\nStep 1: tunnel token not written to ${tokenFile}. Is -TokenOutFile supported by the script?`)); return 1; }

    // 2. Service token — idempotent: an existing same-name token is ROTATED (new
    //    secret, same token id) so any policy referencing it stays valid; delete
    //    would be refused with 12139 service_token_in_use once a policy exists.
    step(2, `Service token aegis-${v.name} (Cloudflare API)`);
    const existing = await cf.findServiceTokenByName(R.accountId, `aegis-${v.name}`, R.cfToken);
    let token;
    if (existing) {
      console.log(c.dim(`  token exists (${existing.id}) — rotating for a fresh usable secret (policy references stay valid)`));
      token = await cf.rotateServiceToken(R.accountId, existing.id, R.cfToken);
      console.log(c.green(`  rotated — clientId ${token.clientId}  (secret held in-memory)`));
    } else {
      token = await cf.createServiceToken(R.accountId, `aegis-${v.name}`, R.cfToken);
      console.log(c.green(`  created — clientId ${token.clientId}  (secret held in-memory)`));
    }

    // 3. Service Auth policy
    step(3, 'Service Auth policy on the agent app (Cloudflare API)');
    const app = await cf.findAppByHostname(R.accountId, R.d.cloudflare.fqdn, R.cfToken);
    if (!app) { console.log(c.red(`  app for ${R.d.cloudflare.fqdn} not found — did step 1 create it?`)); return 1; }
    const action = await cf.upsertServiceAuthPolicy(R.accountId, app.id, `aegis-${v.name}`, token.id, R.cfToken);
    console.log(c.green(`  policy ${action} on app ${app.id}`));

    // 4. Register (in-process; secret -> gitignored config only)
    step(4, 'Register in aegis.config.json');
    const rc = runRegister(file, { clientId: token.clientId, clientSecret: token.clientSecret, aegisConfig: opts.aegisConfig });
    if (rc !== 0) { console.log(c.red('  register failed — token + policy exist; fix the config and re-run register.')); return rc; }

    // 5. Deploy — billable, last
    step(5, `Deploy the VM (BILLABLE) — ${R.d.azure.resourceGroup} / ${R.d.azure.vmName}`);
    let backupAcct = backup.resolveAccount();
    if (!backupAcct) backupAcct = backup.resolveAccount(); // one retry: a transient az hiccup here once baked an empty BACKUP_ACCOUNT into a live agent (permanently no-op nightly backup)
    if (!backupAcct) console.log(c.yellow('  backup: BACKUP_ACCOUNT resolved EMPTY — fine if the fleet store is absent by design; if `fleetctl backup list <agent>` works, Ctrl+C and re-run, because this build ships a no-op backup timer.'));
    const ok5 = runScript(R.bash, ['scripts/deploy.sh', v.profile, v.name], {
      cwd: R.fleetRoot,
      env: { ...deployEnv(v, R.pubkey, tunnelToken), BACKUP_ACCOUNT: backupAcct },
    });
    if (!ok5) {
      // Ghost-card guard: register ran before deploy (in-process token handoff), so a
      // failed deploy must deregister -- otherwise Aegis shows a card with nothing behind it.
      try {
        const { runDeregister } = require('./register');
        if (typeof runDeregister === 'function') runDeregister(v.name, { aegisConfig: opts.aegisConfig });
        console.log(c.yellow('  deregistered from Aegis (no ghost card). CF front door + token remain for retry.'));
      } catch (e) { console.log(c.yellow('  deregister after failed deploy also failed: ' + e.message)); }
      console.log(c.red('\nStep 5 failed (deploy.sh). Fix and re-run up --go, or decommission to sweep the CF surfaces.'));
      return 1;
    }

    console.log(c.green(`\nup --go OK — ${v.name} provisioned. cloud-init is building the image (~4-8 min).`));
    console.log(c.green('  The VM is WAITING for its vault seed — it self-configures once seeded (no SSH).'));
    backup.ensureAgentBackup(v.name);
    console.log(c.bold('  NEXT (within ~10 min): seed the vault so it comes up on its own →'));
    console.log(c.bold('    fleetctl set-secrets ' + v.name + '   ') + c.dim('(enrolls TOTP + writes the API keys)'));
    console.log(c.dim('  Wait ~1 min first (Key Vault role propagation), then set-secrets. Do NOT re-run up --go'));
    console.log(c.dim('  (RG-exists guard aborts) and do NOT ssh+bootstrap (old flow). Then: fleetctl check ' + file + ' --live'));
    console.log(c.dim('Aegis reads aegis.config.json at startup — restart it (node aegis.js) to show the new agent.'));
    return 0;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.log(c.red('\nup --go FAILED: ' + msg));
    if (/\b10000\b|authentication|authoriz|forbidden|permission|\b9109\b/i.test(msg)) {
      console.log(c.yellow('  Looks like a Cloudflare API permission problem. The token minting the service'));
      console.log(c.yellow('  token needs "Access: Service Tokens · Edit" (on top of Access Apps & Policies,'));
      console.log(c.yellow('  DNS, and Cloudflare Tunnel). Add it to $CF_API_TOKEN, then re-run.'));
    }
    console.log(c.dim('  The Cloudflare front door may already exist (cloudflare-provision.ps1 is idempotent) — re-running is safe.'));
    return 1;
  } finally {
    try { fs.unlinkSync(tokenFile); } catch { /* best effort */ }
  }
}

module.exports = { runUp, deployEnv };

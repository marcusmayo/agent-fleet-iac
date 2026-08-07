#!/usr/bin/env node
'use strict';
const { runCheck } = require('../lib/check');
const { runPlan } = require('../lib/plan');
const { runRegister, runDeregister } = require('../lib/register');
const { runSetSecrets } = require('../lib/secrets');
const { runCheckLive } = require('../lib/live');
const { runUp } = require('../lib/up');
const { runDecommission } = require('../lib/decommission');
const { c } = require('../lib/util');

const HELP = `fleetctl — agent-fleet provisioning

Usage:
  fleetctl check    <contract.agent.jsonc> [--contract-only] [--live] [--aegis-config <path>]
  fleetctl plan     <contract.agent.jsonc> [--require-whatif]
  fleetctl up       <contract.agent.jsonc> [--go] [--aegis-config <path>]
  fleetctl register <contract.agent.jsonc> [--aegis-config <path>]
  fleetctl deregister <name | contract.agent.jsonc> [--aegis-config <path>]
  fleetctl decommission <contract.agent.jsonc> [--go] [--aegis-config <path>]
  fleetctl policy   [show] | set <key> <value> --attest "I approve setting <key> to <value>"
  fleetctl set-secrets <agent>
  fleetctl --help

Commands:
  check     Validate the contract, then preflight the environment (az login,
            CF_API_TOKEN, SSH key, bicepparam, deployer id for castor).
            --contract-only   validate the file only; skip environment preflight.
            --live            skip env preflight; instead probe the deployed agent's
                              /health/liveliness through the tunnel (HTTP 200) using
                              the service token stored in aegis.config.json.
            --require-live    exit non-zero if the live probe can't run (for CI).

  plan      Validate the contract and preview every Azure + Cloudflare + register
            resource it will create, then run \`az deployment sub what-if\` (read-only).
            --require-whatif  exit non-zero if the what-if cannot be run (for CI).

  up        Bring up a new agent end to end. Default prints the full ordered plan
            (cheap/reversible steps first, the billable VM last) and changes nothing.
            --go   execute: Cloudflare front door (cloudflare-provision.ps1) -> service
                   token + Service Auth policy (CF API) -> register -> deploy.sh (VM).
                   Needs \$CF_API_TOKEN, \$CF_ACCOUNT_ID, \$CF_OPERATOR_EMAIL, an SSH key,
                   and pwsh + bash + az. Fails fast; the secret is never printed.
                   Aborts if rg-<name> already exists (cloud-init is immutable on a
                   live VM) — decommission first for a rebuild, or pass --update for
                   an intentional in-place update that does not change cloud-init.

  register  Add/update the agent's entry in aegis.config.json (idempotent per name;
            refuses if that file is not gitignored). Service-token credentials come
            from \$AEGIS_CLIENT_ID + \$AEGIS_CLIENT_SECRET (or from \`up\`, in-process) —
            never from CLI flags. The secret is written to the config, never printed.

  deregister  Remove an agent's entry from aegis.config.json (by name or contract) so
            Aegis self-updates on decommission. Idempotent; never touches other agents.

  policy    Show or change the fleet governance gate (provision/aegis.policy.jsonc).
            show prints current caps + the last attested actions. set mutates ONE
            value in place (comments preserved), verifies the re-read, and appends
            the attempt -- approved or refused -- to provision/policy-audit.jsonl.
            Keys: maxFleet maxBatch budget allowedRegions defaultRegion budgetName.
            Cross-checks fail closed (batch<=fleet; defaultRegion must stay inside
            allowedRegions). Attestation must read exactly: I approve setting <key> to <value>

  set-secrets  Seed an agent's Key Vault with the three bootstrap secrets so it can
            self-configure at first boot. TOTP is generated here (enroll the printed QR /
            secret); the two API keys are read from \$ANTHROPIC_API_KEY + \$OPENROUTER_API_KEY
            in the environment (never passed as args). Requires az + Secrets Officer on the vault.

  --aegis-config <path>   Path to aegis.config.json (else \$AEGIS_CONFIG, \$AEGIS_DIR,
                          or <fleet-parent>/aegis/aegis.config.json).

check/plan make no changes. register writes only to the local (gitignored) config.`;

const VALUED = new Set(['--aegis-config']);

function parseArgs(rest) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (VALUED.has(a)) opts[a.slice(2)] = rest[++i];
      else flags.add(a);
    } else {
      positional.push(a);
    }
  }
  return { flags, opts, file: positional[0] };
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  const cmd = args[0];
  const { flags, opts, file } = parseArgs(args.slice(1));
  const aegisConfig = opts['aegis-config'];

  if (cmd === 'check') {
    if (!file) { console.error(c.red('check: missing <contract.agent.jsonc>')); return 2; }
    if (flags.has('--live')) return runCheckLive(file, { aegisConfig, requireLive: flags.has('--require-live') });
    return runCheck(file, { contractOnly: flags.has('--contract-only') });
  }
  if (cmd === 'plan') {
    if (!file) { console.error(c.red('plan: missing <contract.agent.jsonc>')); return 2; }
    return runPlan(file, { requireWhatif: flags.has('--require-whatif') });
  }
  if (cmd === 'register') {
    if (!file) { console.error(c.red('register: missing <contract.agent.jsonc>')); return 2; }
    return runRegister(file, { aegisConfig });
  }
  if (cmd === 'deregister') {
    if (!file) { console.error(c.red('deregister: missing <name-or-contract>')); return 2; }
    return runDeregister(file, { aegisConfig });
  }
  if (cmd === 'set-secrets') {
    if (!file) { console.error(c.red('set-secrets: missing <agent>')); return 2; }
    return runSetSecrets(file);
  }
  if (cmd === 'up') {
    if (!file) { console.error(c.red('up: missing <contract.agent.jsonc>')); return 2; }
    return runUp(file, { go: flags.has('--go'), update: flags.has('--update'), aegisConfig });
  }
  if (cmd === 'decommission') {
    if (!file) { console.error(c.red('decommission: missing <contract.agent.jsonc>')); return 2; }
    return runDecommission(file, { go: flags.has('--go'), aegisConfig });
  }

  if (cmd === 'policy') {
    const { showPolicy, setPolicy } = require('../lib/policy');
    const rest = args.slice(1);
    const sub = rest[0];
    if (!sub || sub === 'show') { console.log(showPolicy()); return 0; }
    if (sub === 'set') {
      const ai = rest.indexOf('--attest');
      const attest = ai >= 0 ? (rest[ai + 1] || '') : '';
      const pos = rest.slice(1).filter((a, i, arr) => a !== '--attest' && arr[i - 1] !== '--attest');
      try {
        const r = setPolicy({ key: pos[0], value: pos[1], attest });
        console.log(c.green(`policy: ${r.key} ${r.from} -> ${r.to}`) + c.dim(`  (${r.path}; ledgered ${r.ledgered})`));
        return 0;
      } catch (e) { console.error(c.red(String(e.message || e))); return 2; }
    }
    console.error(c.red(`policy: unknown subcommand "${sub}" — use: policy show | policy set <key> <value> --attest "..." (keys: maxFleet maxBatch budget allowedRegions defaultRegion budgetName)`));
    return 2;
  }

  console.error(c.red(`unknown command "${cmd}"`) + '\n');
  console.error(HELP);
  return 2;
}

Promise.resolve(main(process.argv)).then((code) => process.exit(code)).catch((e) => {
  console.error(c.red('fatal: ' + (e && e.message ? e.message : e)));
  process.exit(1);
});

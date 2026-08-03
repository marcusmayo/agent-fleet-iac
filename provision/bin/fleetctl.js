#!/usr/bin/env node
'use strict';
const { runCheck } = require('../lib/check');
const { runPlan } = require('../lib/plan');
const { c } = require('../lib/util');

const HELP = `fleetctl — agent-fleet provisioning (Phase 1: read-only)

Usage:
  fleetctl check <contract.agent.jsonc> [--contract-only]
  fleetctl plan  <contract.agent.jsonc> [--require-whatif]
  fleetctl --help

Commands:
  check   Validate the per-agent contract, then preflight the environment
          (az login, CF_API_TOKEN, SSH key, bicepparam, deployer id for castor).
          --contract-only   validate the file only; skip environment preflight.

  plan    Validate the contract and preview every Azure + Cloudflare + register
          resource it will create, then run \`az deployment sub what-if\` (read-only).
          --require-whatif  exit non-zero if the what-if cannot be run (for CI).

Neither command changes anything. Contracts live in agents/<name>.agent.jsonc.`;

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  const cmd = args[0];
  const rest = args.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const file = rest.find((a) => !a.startsWith('--'));

  if (cmd === 'check') {
    if (!file) { console.error(c.red('check: missing <contract.agent.jsonc>')); return 2; }
    return runCheck(file, { contractOnly: flags.has('--contract-only') });
  }
  if (cmd === 'plan') {
    if (!file) { console.error(c.red('plan: missing <contract.agent.jsonc>')); return 2; }
    return runPlan(file, { requireWhatif: flags.has('--require-whatif') });
  }

  console.error(c.red(`unknown command "${cmd}"`) + '\n');
  console.error(HELP);
  return 2;
}

process.exit(main(process.argv));

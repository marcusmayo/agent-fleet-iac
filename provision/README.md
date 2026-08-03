# agent-fleet provisioning CLI (`fleetctl`)

A phased, contract-validated wrapper over the same Bicep + Cloudflare provisioning
you run by hand. Each agent is described by one committed, secret-free contract at
`agents/<name>.agent.jsonc`; the CLI is the only interpreter of that contract and
validates every input it renders from.

Zero runtime dependencies. Node >= 18.

## Read-only commands — `check` and `plan`

```
node bin/fleetctl.js check agents/<name>.agent.jsonc [--contract-only]
node bin/fleetctl.js plan  agents/<name>.agent.jsonc [--require-whatif]
```

- **check** — validate the contract, then preflight the environment: `az login`,
  `CF_API_TOKEN`, an SSH public key, the profile's `bicepparam`, and (castor only)
  the deployer object id. Exits non-zero if a blocking item fails.
  `--contract-only` validates the file and stops (no environment probing).
- **plan** — validate the contract, print every Azure + Cloudflare + register
  resource that will be created (names derived to match `vm.bicep` and
  `cloudflare-provision.ps1`), then run `az deployment sub what-if` (read-only).
  If `az` is absent or not logged in, the exact command is printed and the
  what-if is skipped loudly. `--require-whatif` makes a skip exit non-zero.

Neither command mutates anything (cloud or local).

## Contract shape

```jsonc
{
  "contract": 1,          // compat floor; unknown MAJOR fails closed
  "name": "atlas-01",     // ^[a-z][a-z0-9-]{1,23}$, no trailing hyphen (DNS label)
  "profile": "keel",      // castor | keel
  "domain": "keel-pm.com",// optional (default keel-pm.com)
  "webchatPort": 8443,    // optional (default 8443)
  "region": "eastus2",    // optional (default eastus2)
  "sshCidr": "",          // optional; "" = hardened (no public IP), else a /32 CIDR
  "repoUrl": "",          // optional override; default is per-profile
  "repoRef": ""           // optional; "" = default-branch HEAD
}
```

Secret-shaped keys (`*token*`, `*secret*`, `*password*`, `*api_key*`, …) and
unknown keys are rejected. Secrets never live in the contract — they come from the
environment / Key Vault at run time.

## Tests

```
npm test        # node --test  (jsonc + contract)
```

## Full commands

Beyond the read-only `check`/`plan` above, the CLI also drives a live bring-up:

- **`up <contract>`** — prints the full ordered runbook (plan); `--go` executes it:
  Cloudflare front door → service token + Service Auth policy → register → deploy the VM.
- **`register <contract>`** — upserts the agent into `aegis.config.json` (fail-closed if
  the file isn't gitignored; secret never printed).
- **`check <contract> --live`** — probes the deployed agent's `/health/liveliness` (HTTP 200)
  through the tunnel using the token in `aegis.config.json`.

The end-to-end "bringing up a new agent" runbook — every step, with the environment it
needs — lives in the repo's top-level `README.md`.

Agent name branding at spin-up is wired via `__AGENT_NAME__` in the `vm.bicep` cloud-init
replace chain (so `system/agent.yaml` reflects the agent's own name). The Express endpoint
in `../aegis/aegis-provision.js` remains the separate, deferred **approach-B** seam (the
"Add agent" button wraps this same deploy path); it is not part of this CLI.

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

### Bringing one up, in order

1. **`up <contract> --go --attest "I approve provisioning <n>"`** — cheap and reversible
   surfaces first, the VM last. Runs the repo gate: the agent repo at the contract's ref is
   cloned and its vendored fleet-core hashed against its stamps, and `--go` refuses a repo
   that would fail its own image build.
2. **`set-secrets <n>`** — writes the API keys to the agent's Key Vault. Reads them from
   `$ANTHROPIC_API_KEY` / `$OPENROUTER_API_KEY`; it does not prompt. Profiles map them
   differently (keel takes the pair as-is; castor also seeds `model-api-key` and
   `vision-api-key`). The VM fetches them itself at first boot — no SSH.
3. **`check <contract> --live`** — 200 is the only PASS. 403 means Access rejected the token,
   502 means the tunnel is up but the webchat is still building or waiting for its seed, 530
   means the tunnel is down. `--logs` reads the VM's own build and bootstrap logs.
4. **`enroll <n> --plane=<plane> --go --attest "…"`** — until this runs the agent is healthy
   but invisible to the hosted panel. **Two planes, two registries:** `up` on a workstation
   registers it there; the panel's plane keeps its own. `discover` shows what one plane holds
   that the other does not, and the panel's Refresh surfaces it as an Enroll door.

Each plane names its service token `<plane>-<agent>`, so an agent's chain records which plane
commanded a thing. A decommission removes every plane's token.

## Backups, and the three retention classes

One store (`rg-fleet-backups`), one account, three classes. Retention is a property of the
**container**, never of the agent, so a new agent inherits all three the day it exists.

| class | what it holds | lifecycle |
|---|---|---|
| `<agent>/` | the nightly machine-state tarball — rebuildable spare parts | deleted after 14 days |
| `records/` | curated content an operator reads and acts on | **never deleted**; `data/` tiers Cool 30d → Archive 180d; `index/` never tiers |
| `ledgers/` | hash chains — metadata and hashes, never content | **never deleted**; same tiering; plus an unlocked container immutability policy |

Azure lifecycle filters are include-only, so the delete rule **names** the operational
containers it may empty and cannot reach the permanent classes by construction. `up` enrols a
new agent into that rule; a lapse there means an agent's spare parts stop being deleted, which
costs money rather than losing anything.

- **`backup init`** — creates the store, both permanent containers, their READMEs, the
  lifecycle document and the immutability policy. Idempotent; safe to re-run.
- **`backup list <agent>` · `backup snapshot <agent>`** — what is held, and force one now.
- **`backup ls <container> [--prefix p]`** — tier, date, size and name, and how many sit in
  Archive.
- **`backup get <container> <blob> [--out path]`** — refuses an Archive blob, naming the state
  and the exact rehydrate command rather than dying on a raw Azure error.
- **`backup rehydrate <container> <blob> [--priority High|Standard]`** — high is usually under
  an hour for objects this size; standard can take up to about fifteen hours.
- **`restore <agent> [--blob n]`** — **a MERGE, not a rewind.** The snapshot is written back
  over the live volumes and anything created since it is **kept**. That is deliberate: a
  recovery must never silently delete work written after the backup.

## Intake — getting files to an agent

Files land in the agent's own container under `intake/`, and the agent sweeps them into
`state/staging` on a five-minute timer. The sweep **stages only** — Process is still the
operator's decision, exactly as it is for a panel upload — and it is a queue, not a mirror: a
blob is deleted only after the file is on disk.

- **`intake put <agent> <file…>`** — the desk path. Names are stamped, so two screenshots
  called the same thing stay two items.
- **`intake list <agent>`** — what has not been swept yet.
- From any other machine, use the panel's per-card import, which stages over the same
  authenticated path. `fleetctl` runs on the **Aegis host** only — your workstation, or the
  hosted plane; agents never run it and have no path to it.

## Rebuilding and policy

- **`rebuild <contract> [--head <sha>] [--go]`** — restores tracked dirt, shows the identity
  overlay, pulls, asserts the named HEAD and refuses anything else, builds (verify-core runs
  inside), bootstraps, and reads back containers, the agent's own name and liveliness. Plan
  mode says plainly that it restarts the agent.
- **`policy show [--json]` · `policy set <key> <value> --attest …` · `policy protect|unprotect
  <n> --attest …`** — every attempt is ledgered, refusals included. A control with an Azure
  mirror (the `fleet-protect` lock, the budget object) ledgers **`incomplete:`** and exits 1
  when the gate applied but the mirror did not; exit 1 means half-applied and nothing else.
- **`discover [--json]`** — what Azure holds against this plane's registry.
- **Audit export** takes a date range and pages each agent's chain to the beginning,
  re-verifying every record it receives.

Agent name branding at spin-up is wired via `__AGENT_NAME__` in the `vm.bicep` cloud-init
replace chain (so `system/agent.yaml` reflects the agent's own name). The Express endpoint
in `../aegis/aegis-provision.js` remains the separate, deferred **approach-B** seam (the
"Add agent" button wraps this same deploy path); it is not part of this CLI.

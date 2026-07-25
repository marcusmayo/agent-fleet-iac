# Agent Fleet — Bicep IaC + Walkthrough Runbook

Stand up a **Castor-profile VM** and a **Keel-profile VM**, add a **second Castor VM through the
frontend**, then **decommission it** — testing each for functionality. One converged image, one
Bicep module, per-agent isolation, Cloudflare-Tunnel transport.

> **How to use this:** I authored *and* locally validated these templates (Bicep compiles with
> zero diagnostics; shell + Node + cloud-init syntax-checked — see **Validation record** at the
> bottom). I can't deploy to *your* Azure from my side, so the steps below are yours to run. Every
> command is copy-paste, with the expected output and a ✅ check after it.

---

## What you'll stand up

| Agent | Profile | Role | Resource group |
|---|---|---|---|
| **heimdall** | `castor` | multi-interface assistant | `rg-heimdall` |
| **helm** | `keel` | portfolio-management engine | `rg-helm` |
| **cerberus** | `castor` | added **via the frontend**, then decommissioned | `rg-cerberus` |

**One architecture, not two:** `castor` and `helm`/`keel` are the *same* image and the *same* module —
only the `agentProfile` parameter and the per-agent data differ. Each agent is its own resource
group (a clean bulkhead: decommission = delete the group). No public IP by default; the webchat
rides an outbound-only Cloudflare Tunnel.

---

## Prerequisites (your side)

- An **Azure subscription** + the **`az` CLI** (`az version`), logged in.
- A **Cloudflare account** with a domain on Cloudflare and **Zero Trust** enabled (free tier is fine).
- A **model API key** (Anthropic, or an OpenRouter key if you front it with LiteLLM).
- An **SSH keypair** (we create one below).
- This bundle unzipped locally; run all commands from its root.

```
agent-fleet-iac/
├── bicep/
│   ├── main.bicep                    # subscription-scoped: RG + VM module
│   ├── modules/vm.bicep              # network + compute (no public IP unless SSH_CIDR set)
│   ├── cloud-init/agent-cloudflared.yaml
│   └── params/{castor,keel}.bicepparam
├── scripts/{deploy,decommission,smoke-test}.sh
├── aegis/aegis-provision.js          # the frontend "Add/Decommission" endpoint (stub)
└── README.md                          # this runbook
```

---

## Part 0 — one-time setup

```bash
az login
az account set --subscription "<YOUR-SUBSCRIPTION-ID>"

# SSH key for bootstrap (skip if you already have one)
ssh-keygen -t ed25519 -f ~/.ssh/agentfleet -N ""
export SSH_PUBKEY="$(cat ~/.ssh/agentfleet.pub)"
export AZ_LOCATION="eastus2"

# First-run convenience: open SSH from *only* your current IP.
# (Leave SSH_CIDR unset for the hardened, no-public-IP path — see Security notes.)
export SSH_CIDR="$(curl -s https://api.ipify.org)/32"

# Optional: reproducible pinned build. Point REPO_URL at your fork and REPO_REF at
# the exact commit/branch/tag to build (e.g. the commit that adds your ADO lane).
# Leave REPO_REF unset to build the default-branch HEAD.
export REPO_URL="https://github.com/marcusmayo/keel-portfolio-management.git"
export REPO_REF=""   # e.g. a commit SHA, or "feature/ado-normalizer"
```

**Cloudflare tunnel — once per agent** (repeat for heimdall, helm, cerberus). In the Zero Trust
dashboard → **Networks → Tunnels → Create tunnel** (name it after the agent), then:

1. Copy the **tunnel token** (a long `eyJ…` string) — you'll `export CF_TUNNEL_TOKEN=…` per agent.
2. **Public hostname:** `heimdall.<yourdomain>` → service `http://localhost:8443` (the webchat).
3. **Access → Applications → Add self-hosted app** for that hostname, policy = *your email only*
   (this is the edge login in front of the app's own TOTP).
4. *(Hardened path only)* add a second hostname `ssh-heimdall.<yourdomain>` → `ssh://localhost:22`
   and an Access app, so you can bootstrap without any public IP.

> ✅ **Check:** `az account show -o table` prints your subscription, and you have a tunnel token
> per agent.

---

## Part 1 — stand up **heimdall** (Castor profile)

```bash
export CF_TUNNEL_TOKEN="<heimdall tunnel token>"
scripts/deploy.sh castor heimdall
```

Expected (trimmed):

```
>> Deploying agent 'heimdall' (profile: castor) to eastus2
>> SSH bootstrap open from: 203.0.113.5/32 (public IP created)
{
  "rg": "rg-heimdall",
  "profile": "castor",
  "publicIp": true,
  "privateIp": "10.30.0.4"
}
>> Provisioned. cloud-init is now building the image on the VM (~4-8 min).
```

> ✅ **Check:** `az group show -n rg-heimdall -o table` shows `Succeeded`.

**Bootstrap** (inject TOTP + model key — never stored in the template):

```bash
# public-IP path:
PUBIP=$(az network public-ip show -g rg-heimdall -n heimdall-pip --query ipAddress -o tsv)
ssh -i ~/.ssh/agentfleet agentadmin@"$PUBIP"
# --- OR hardened path (no public IP): cloudflared access ssh --hostname ssh-heimdall.<domain>

# on the VM:
cd ~/agent
tail -n 5 -f /var/log/agent-image-build.log     # wait for a line like "BUILT keel:<sha>", then Ctrl-C
./infra/scripts/bootstrap.sh                     # scan the TOTP QR, paste your model API key
```

Expected tail of bootstrap: `publishing webchat on 127.0.0.1:8443` → smoke test → `bootstrap complete`.

**Test heimdall:**

```bash
# on the VM:
~/agent/scripts/smoke-test.sh            # (or: /home/agentadmin/agent from this bundle's scripts)
```

Then from your **phone or laptop browser**: open `https://heimdall.<yourdomain>` → Cloudflare Access
login → the webchat loads → enter your TOTP.

> ✅ **Heimdall checklist:** RG `Succeeded` · image built · `bootstrap complete` · webchat reachable
> at its Cloudflare hostname · TOTP prompt appears · smoke test all PASS.

---

## Part 2 — stand up **helm** (Keel profile)

Same flow, different profile and its own tunnel token:

```bash
export CF_TUNNEL_TOKEN="<helm tunnel token>"
scripts/deploy.sh keel helm
```

Expected: `"rg": "rg-helm", "profile": "keel"`. Bootstrap identically (public-IP or hardened), then
open `https://helm.<yourdomain>`.

**What differs from heimdall:** same image, `agentProfile=keel` written to `.provision-flags`. The
Keel profile is the portfolio engine — try a portfolio skill in the webchat (e.g. ask it to score an
item with WSJF/RICE, or normalize a small backlog). The Castor profile is where you'd instead enable
the Telegram/email interfaces and the drafting skill set.

> ✅ **Helm checklist:** RG `Succeeded` · profile shows `keel` · webchat reachable · a
> portfolio/scoring skill responds · smoke test all PASS.

---

## Part 3 — add **cerberus** (Castor) **through the frontend**

The frontend "Add agent" button calls the Aegis provisioning endpoint (`aegis/aegis-provision.js`),
which is a thin wrapper over the **same** `deploy.sh`. On the Aegis host (with the least-privilege
service principal logged in and per-agent secrets in the vault):

```bash
# what the frontend button does under the hood:
curl -X POST http://127.0.0.1:7070/agents \
  -H 'content-type: application/json' \
  -d '{"name":"cerberus","profile":"castor"}'
# -> { "status": "provisioning", "name": "cerberus", "profile": "castor", "log": "...rg-cerberus..." }
```

Because the endpoint just shells out to `deploy.sh castor cerberus`, the CLI equivalent is identical
(use this if you're testing before wiring the endpoint):

```bash
export CF_TUNNEL_TOKEN="<cerberus tunnel token>"
scripts/deploy.sh castor cerberus
```

Bootstrap + test exactly as in Part 1, at `https://cerberus.<yourdomain>`.

> ✅ **Cerberus checklist:** provision call returns `provisioning` · `rg-cerberus` `Succeeded` ·
> webchat reachable · smoke test all PASS · and note it did **not** touch heimdall or helm.

---

## Part 4 — decommission **cerberus**

Frontend "Decommission" button → `DELETE`, which wraps `decommission.sh … --yes`:

```bash
curl -X DELETE http://127.0.0.1:7070/agents/cerberus
# -> { "status": "decommissioned", "name": "cerberus", "log": "...deleted..." }
```

CLI equivalent (interactive confirm):

```bash
scripts/decommission.sh cerberus        # type "cerberus" to confirm
```

**Verify it's gone:**

```bash
az group show -n rg-cerberus -o table   # expect: (ResourceGroupNotFound)
```

Then the manual offboarding the script reminds you of: delete cerberus's **Cloudflare tunnel + Access
app**, revoke its **model key**, and remove its **Aegis registry entry**.

> ✅ **Decommission checklist:** `az group show` returns *NotFound* · heimdall + helm still reachable
> (isolation held) · Cloudflare tunnel/key revoked.

---

## Part 5 — functionality test matrix (per VM)

| Check | How | Pass = |
|---|---|---|
| Provisioned | `az group show -n rg-<name>` | `Succeeded` |
| Image built | on VM: `grep -c 'BUILT keel' /var/log/agent-image-build.log` | ≥ 1 |
| Container healthy | on VM: `sudo docker inspect -f '{{.State.Health.Status}}' keel-webchat` | `healthy` |
| Webchat reachable | browser: `https://<name>.<domain>` (after Access) | page loads |
| MFA enforced | webchat prompts for TOTP | prompt appears |
| Redaction gate | on VM: `node gate/ask.js "email me at test@example.com"` then check `logs/audit.jsonl` | entity tokenized, audit entry appended |
| State writable | on VM: `scripts/smoke-test.sh` | `state volume writable` PASS |
| Isolation | after cerberus teardown, heimdall/helm still answer | both reachable |

`scripts/smoke-test.sh` bundles the HTTP + container + state checks; run it on each VM.

---

## Cost & full cleanup

Each VM is a **Standard_D2s_v3** (~$70-90/mo if left on; far less for a short test). Tear the whole
fleet down when done:

```bash
scripts/decommission.sh heimdall
scripts/decommission.sh helm
# (cerberus already gone)
```

---

## Security notes

- **Hardened path (recommended for real use):** leave `SSH_CIDR` unset → **no public IP at all**;
  the NSG denies every inbound rule and you bootstrap via `cloudflared access ssh`. The `SSH_CIDR`
  option exists only to make first-run lifecycle testing frictionless.
- **Secrets:** the tunnel token is the only secret in `customData` and is scrubbed from cloud logs
  after install. Runtime secrets (TOTP, model key) are injected over SSH by `bootstrap.sh`, never in
  the template. Production upgrade: pull all three from **Key Vault** via managed identity.
- **Frontend provisioning:** `aegis-provision.js` binds to loopback (reachable only through the
  tunnel), requires the Aegis operator session, validates `name`/`profile` against strict allow-lists
  (no shell injection), and authenticates to Azure with a **least-privilege service principal**
  (Contributor scoped to the fleet subscription — not Owner, not tenant-wide).
- **Data boundary:** each agent processes only owner-authored derivative content; the per-agent
  redaction gate tokenizes entities before any model call.

---

## Validation record (done in-sandbox before handoff)

| Artifact | Tool | Result |
|---|---|---|
| `bicep/main.bicep` (+ vm module) | `bicep build` v0.45.15 | compiles, **0 warnings / 0 errors** |
| `params/castor.bicepparam` | `bicep build-params` | OK |
| `params/keel.bicepparam` | `bicep build-params` | OK |
| `scripts/*.sh` | `bash -n` | all OK |
| `aegis/aegis-provision.js` | `node --check` | OK |
| `cloud-init/agent-cloudflared.yaml` | `yaml.safe_load` | OK |

**Not validated here (needs your accounts):** a live `az deployment` (subscription auth), the
Cloudflare tunnel/Access setup, and end-to-end webchat over the tunnel. Those are the steps in Parts
0–4 for you to run — or we can do them together in a guided session where you paste outputs back and
I troubleshoot.

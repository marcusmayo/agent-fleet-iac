# keel-rebuild-experiment

Comparative one-shot build: four models, one brief, zero intervention. Each
model gets an identical GitHub Codespace, the Pi coding agent, and `AGENTS.md` --
a phased, success-criteria-gated brief for a governed portfolio-reconciliation
agent (Meridian PPM). The models build it autonomously; cost and wall time come
from the OpenRouter activity ledger; the products are judged against the brief's
own oracle (`verify_e2e.py`).

`AGENTS.md` is for the agent. This file is for you.

## Results (July 22, 2026)

Four runs on a uniform harness: Pi 0.81.1, xhigh reasoning (Kimi's "high" is its
maximum), the identical Meridian brief.

| Model | Oracle | Semantic verdict | Propose -> confirm -> audit | Cost (OpenRouter) | Wall time |
|---|---|---|---|---|---|
| DeepSeek V4 Pro | ALL PASS (44/44) | SAME | full chain | $0.276 | ~15 min |
| GLM 5.2 | ALL PASS | DISTINCT | full chain | $0.98 | ~30 min |
| Kimi K3 | ALL PASS (23/23) | DISTINCT | full chain | $1.00 | ~20 min |
| Claude Opus 4.8 | ALL PASS (33/33) | DISTINCT | full chain | $6.09 | ~26 min |

Every model produced a complete, working, oracle-passing build with the full
propose -> confirm -> audit governance flow. Capability was not the
differentiator: all four nailed the deterministic core, the live semantic
judgment on the one ambiguous row, and the governance gate. Cost was the only
real axis, and it does not track capability -- the cheapest model (DeepSeek,
$0.276) was also the fastest and every bit as complete as the frontier model at
roughly 22x the price. The finding: on a well-scoped, machine-verifiable brief,
the moat is the brief and the oracle, not the model choice.

Two notes on reading the table. The oracle counts differ (44 / 33 / 23) because
each agent wrote its own test granularity -- all four reached ALL PASS against
the same brief numbers, so 44 is not "more thorough" than 23. The semantic
verdict split (DeepSeek SAME; GLM, Kimi, Opus DISTINCT) is a legitimate judgment
difference on a genuinely ambiguous row ("Autonomous vehicle fleet navigation"
vs "Autonomous fleet routing optimization"), not a failure -- it is exactly the
case the semantic lane exists for.

Per-model builds are preserved as branches: `result/deepseek-v4-pro`,
`result/glm-5.2`, `result/kimi-k3`, `result/claude-opus-4.8`. The discarded pilot
(an early DeepSeek run on Pi 0.73.1 -- wrong harness, failed the semantic lane,
static UI) is kept as honest evidence on `pilot/deepseek-v4-pro-073`.

## Re-run it (repeat once per model)

Note: `AGENTS.md` is the brief and must stay untouched between runs so every
build starts uncontaminated. Only this README is human-facing; the agent builds
from `AGENTS.md`.

1. On GitHub: Code -> Codespaces -> Create codespace on `main`. One codespace per
   model. The dev container auto-installs Pi, the agent-browser CLI, and Chrome
   via postCreate.

2. Confirm the harness version. This experiment standardized on Pi 0.81.1:

       pi --version && agent-browser --version

   If Pi is not 0.81.1, update it:

       pi update

   Note: the Pi package publisher scope changed in 2026, so a version-pinned
   `npm install -g @mariozechner/pi-coding-agent@0.81.1` fails with ETARGET.
   `pi update` is the reliable path -- it brought every codespace in this
   experiment to 0.81.1. Do not skip this: Pi 0.73.1 lacks several models in its
   registry and silently falls back to a different provider, which invalidates
   the run.

3. Create `.env` and set this codespace's key and model:

       cp .env.example .env
       # edit .env: OPENROUTER_API_KEY=sk-or-v1-...
       # edit .env: LLM_MODEL=<this codespace's slug>

   Slugs, one per codespace:
   `z-ai/glm-5.2` | `deepseek/deepseek-v4-pro` | `moonshotai/kimi-k3` | `anthropic/claude-opus-4.8`

4. Register the agent-browser skill for Pi (interactive, once per codespace):

       npx skills add vercel-labs/agent-browser

   Select `pi` (spacebar, then Enter); install for the project: yes.

5. Load the env and start Pi on this codespace's model:

       set -a; source .env; set +a
       pi --models "$LLM_MODEL"

   Confirm the footer shows the intended slug and reasoning level. If the flag
   did not register, run `/model` inside Pi and type the full slug. Then use
   Shift+Tab to set reasoning to the highest available (xhigh).

6. Record the start time in a second terminal:

       date -u

7. Kick off with exactly this prompt, then do not intervene:

       Please build the entire project as described in AGENTS.md. Do not stop
       until all success criteria are met and the server is running and ready
       for me to test.

## OpenRouter billing (read before a frontier run)

The API key has two independent controls: a per-key spend limit and the
account's prepaid credit balance. A 402 "requires more credits" can mean the
account credit balance is low even when the key limit is high -- and the error
links to the key page, which is misleading. Check the account balance at
openrouter.ai/settings/credits, not just the key limit.

Budget per run: open models ~$0.28-$1.00; the frontier model (Opus 4.8) ~$6.
Load enough credit before a frontier run -- this experiment used $40+ of
headroom. Codespaces idle out at ~240 minutes; keep the tab connected. The plan
allows two running codespaces at once -- stop others to free a slot.

## Measuring

- Cost and wall time: OpenRouter -> Activity, filtered to the run window. The
  ledger is the cost of record; the Pi footer disagrees with it -- use the
  ledger.
- Quality gate: run `bash run_e2e.sh` yourself -- it must end in oracle ALL PASS.
  The agent's own "verified" claim does not count. Then open the forwarded port
  8000 and walk the webchat: a wrong TOTP code is rejected and a correct one
  reaches the dashboard; the dashboard shows 11 / 4 / 2 / 1 / 1 / 1 / 2 and
  unconfirmed 6; one status change requires the confirm step and appends exactly
  one line to `logs/audit.log`; the Excel export has four sheets (Cross-Source
  15, Source-Only 6, Unconfirmed 6, Semantic 1); no delete affordance exists
  anywhere.
- Isolation: one codespace per model, no hints, no fixes, no copying between
  runs. If a run stalls terminally, record it as a result, not a restart.
- Contamination check: skim the Pi session log for attempts to fetch external
  repositories or existing implementations. A run that clones its way to the
  answer is invalid, not a build.
- Preserve each build: export the codespace to a branch (`result/<model>`) so it
  survives codespace deletion.

# fleet-core (shared agent core)

Canonical shared source for the agent fleet (Castor / Keel profiles), living in
`agent-fleet-iac/core/` and vendored into each agent repo with build-time hash checks.
**Edit shared code here, once.**

## Why vendored (not fetched)

Each agent repo stays a self-contained, hermetically buildable unit -- Aegis can
clone-and-deploy any agent with zero build-time network dependency. Shared files are
committed *in* each agent; a SHA256 manifest carried in a `.fleet-core-version` stamp
plus an in-build `verify-core.sh` guarantee a vendored copy can never silently drift.

## Layout (agent-fleet-iac/core/)

    *.js                  modules that vendor into each agent's scripts/ dir
      model-routing.js      tier resolver + slug selection + gateway-config gen
      capability.js         capability-registry reader (requireCapability)
      audit-log.js  health-check.js  notify.js  redact.js  redaction-gate.js  scan-tree.js
    manifest.sha256       SHA256 of each scripts-dest module (drift gate)
    gate/                 modules that vendor into each agent's gate/ dir (egress / Can't-Shouldn't)
      ask.js  audit.js  gate.js  redact.js  tripwire.js
      manifest.sha256       SHA256 of each gate-dest module
    sync-core.sh          vendor both destinations into an agent repo
    verify-core.sh        build-time: fail if a vendored copy != the manifest in its stamp
    README.md             this file

## The rule (propagation is deliberate)

Change a shared module **only in core/ here**, then propagate:

    # 1. refresh the affected manifest:
    ( cd core && sha256sum *.js ) > core/manifest.sha256
    ( cd core/gate && sha256sum *.js ) > core/gate/manifest.sha256
    git add core/<changed> && git commit -m "core: <what>" && git push

    # 2. sync into each agent repo (from an agent-fleet-iac checkout):
    ./core/sync-core.sh ~/castor                    scaffold/scripts scaffold/gate
    ./core/sync-core.sh ~/keel-portfolio-management scripts          gate

    # 3. in each agent repo: commit the vendored files + .fleet-core-version, rebuild --no-cache.

## Build-time verification (in each agent Dockerfile)

    COPY gate/ /app/gate/
    RUN  bash /app/gate/verify-core.sh /app/gate
    COPY scripts/ /app/scripts/
    RUN  bash /app/scripts/verify-core.sh /app/scripts

## Currently vendored by

| Profile | scripts dest     | gate dest     |
|---------|------------------|---------------|
| castor  | scaffold/scripts | scaffold/gate |
| keel    | scripts          | gate          |

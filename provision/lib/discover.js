'use strict';
// discover.js -- what Azure holds against what THIS plane's registry holds; changes nothing.
//
// Every fleet agent's RG is tagged app=agent-fleet, agent=<name>, profile=<profile> by the
// template (the control plane's own RG carries role=control-plane and no profile). A registry and
// Azure drift apart in two directions: an agent provisioned by another plane (a workstation up,
// another operator) is in Azure and not here -- an Enroll away; a registry entry whose RG is gone
// (decommissioned from another plane) is a card that reports reachable-or-not about nothing -- a
// registry-only Decommission away. Two planes, two registries, one Azure: this is the read that
// lets each plane see the other's work. `--json` is what the panel's Refresh calls.
const { c, runCapture, findFleetRoot } = require('./util');
const cfg = require('./aegisconfig');
const { agentIdentity } = require('./enroll');
const { planeName } = require('./plane');

// Pure. registry: [{name, profile}], groups: az group list output [{name, location, tags}].
// -> { registered:[{name,profile,region,rg}], unenrolled:[same], gone:[{name,profile}] }
function reconcile(registry, groups) {
  const reg = new Map((registry || []).filter((a) => a && typeof a.name === 'string').map((a) => [a.name, a]));
  const inAzure = new Map();
  for (const g of groups || []) {
    const t = (g && g.tags) || {};
    if (typeof t.agent !== 'string') continue;
    const id = agentIdentity(t, t.agent);       // app=agent-fleet, agent matches, profile present, not a plane
    if (!id.ok) continue;
    inAzure.set(t.agent, { name: t.agent, profile: id.profile, region: (g && g.location) || '', rg: (g && g.name) || '' });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return {
    registered: [...inAzure.values()].filter((a) => reg.has(a.name)).sort(byName),
    unenrolled: [...inAzure.values()].filter((a) => !reg.has(a.name)).sort(byName),
    gone: [...reg.values()].filter((a) => !inAzure.has(a.name)).map((a) => ({ name: a.name, profile: a.profile || '' })).sort(byName),
  };
}

function listFleetGroups() {
  const r = runCapture('az', ['group', 'list', '--tag', 'app=agent-fleet', '-o', 'json']);
  if (r.notFound) return { ok: false, reason: 'az CLI not found' };
  if (!r.ok) return { ok: false, reason: (r.stderr || r.stdout || 'az group list failed').split('\n').filter(Boolean)[0] || 'az group list failed' };
  try { return { ok: true, groups: JSON.parse(r.stdout || '[]') || [] }; }
  catch { return { ok: false, reason: 'az group list returned unparseable output' }; }
}

function runDiscover(opts = {}) {
  const plane = planeName(opts.plane);
  const reg = cfg.resolveConfigPath(opts.aegisConfig, findFleetRoot());
  let registry = [];
  let registryOk = !!(reg.path && reg.exists);
  if (registryOk) { try { registry = cfg.load(reg.path).agents || []; } catch { registryOk = false; } }
  const az = listFleetGroups();
  const rec = az.ok ? reconcile(registry, az.groups) : { registered: [], unenrolled: [], gone: [] };
  const out = { plane, registryPath: reg.path || null, registryOk, azureOk: az.ok, azureReason: az.reason || '', ...rec };
  if (opts.json) { console.log(JSON.stringify(out)); return (out.azureOk && out.registryOk) ? 0 : 1; }
  console.log(c.cyan('discover  ') + c.dim(`plane ${plane} · registry ${reg.path || '(unresolved)'}`));
  if (!registryOk) console.log(c.red('  registry    unresolved -- set $AEGIS_CONFIG or pass --aegis-config (Azure is still read below)'));
  if (!az.ok) { console.log(c.red('  azure       ' + az.reason)); return 1; }
  const show = (l) => l.map((a) => a.name + (a.profile ? ' (' + a.profile + (a.region ? ', ' + a.region : '') + ')' : '')).join(', ');
  console.log('  registered  ' + (rec.registered.length ? show(rec.registered) : c.dim('none')));
  console.log('  unenrolled  ' + (rec.unenrolled.length ? c.yellow(show(rec.unenrolled)) + c.dim('   in Azure, not in this registry -- fleetctl enroll <name>') : c.dim('none')));
  console.log('  gone        ' + (rec.gone.length ? c.yellow(show(rec.gone)) + c.dim('   in this registry, no RG in Azure -- decommission (registry-only) drops the card') : c.dim('none')));
  return registryOk ? 0 : 1;
}

module.exports = { runDiscover, reconcile, listFleetGroups };

'use strict';
// capacity.js — an Azure Can't that a lane must see BEFORE ARM does.
//
// Two different controls decide whether a size can be provisioned in a region, and the
// first live run of the aegis lane found the gap between them: `az vm list-skus` said
// Standard_B2ats_v2 was offered in northcentralus with no restrictions, and ARM refused
// with QuotaExceeded because the subscription held ZERO cores of standardBasv2Family
// there -- a family it had never provisioned in that region. Offered is not permitted.
// The lane's own gates (policy, budget) had all passed; the refusal came from Azure at
// the last possible moment. ARM validates the whole template first, so nothing was
// created -- but a preflight here names the exact quota to request instead of a
// tracking id, and it runs in `plan`, before anyone types an attestation.
//
// readCapacity does the two az reads; evalCapacity is pure and tested (same split as
// budget.js: the decision is testable without Azure). Nothing here mutates anything.
const { runCapture } = require('./util');

function readCapacity(region, vmSize) {
  const sk = runCapture('az', ['vm', 'list-skus', '-l', region, '--size', vmSize, '-o', 'json']);
  const us = runCapture('az', ['vm', 'list-usage', '-l', region, '-o', 'json']);
  let skus = null; let usage = null;
  try { skus = JSON.parse(sk.stdout || 'null'); } catch { skus = null; }
  try { usage = JSON.parse(us.stdout || 'null'); } catch { usage = null; }
  return {
    skus, usage,
    skusErr: sk.ok ? '' : ((sk.stderr || 'az vm list-skus failed').split('\n')[0]),
    usageErr: us.ok ? '' : ((us.stderr || 'az vm list-usage failed').split('\n')[0]),
  };
}

// Numbers only; empty/absent is null, never 0 (a false zero on a LIMIT reads as "no
// quota" which is at least loud, but on USAGE it would read as "plenty of room").
const num = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
};

function requestLine(region, name, want) {
  return 'az quota create --resource-name ' + name +
    ' --scope /subscriptions/<sub-id>/providers/Microsoft.Compute/locations/' + region +
    ' --resource-type dedicated --limit-object value=' + want;
}

// -> { ok, detail, family?, vcpus?, request? }
function evalCapacity(region, vmSize, cap) {
  if (!cap || !Array.isArray(cap.skus)) {
    return { ok: false, detail: 'SKU catalog for ' + region + ' unreadable' + (cap && cap.skusErr ? ' (' + cap.skusErr + ')' : '') };
  }
  const sku = cap.skus.find((s) => s && s.name === vmSize);
  if (!sku) return { ok: false, detail: vmSize + ' is not offered in ' + region };
  const restr = (sku.restrictions || []).map((r) => (r && r.reasonCode) || 'restricted');
  if (restr.length) return { ok: false, detail: vmSize + ' in ' + region + ': ' + restr.join(', ') + ' (offered elsewhere; try another region)' };
  const family = sku.family || '';
  const vcap = (sku.capabilities || []).find((k) => k && k.name === 'vCPUs');
  const vcpus = vcap ? num(vcap.value) : null;
  if (!family || vcpus === null || vcpus <= 0) return { ok: false, detail: 'family/vCPUs for ' + vmSize + ' unreadable from the SKU catalog' };
  if (!Array.isArray(cap.usage)) {
    return { ok: false, detail: 'quota usage for ' + region + ' unreadable' + (cap.usageErr ? ' (' + cap.usageErr + ')' : ''), family, vcpus };
  }
  const find = (n) => cap.usage.find((u) => u && u.name && u.name.value === n);
  const fam = find(family);
  const cores = find('cores');
  const fl = fam ? num(fam.limit) : null;
  const fu = fam ? num(fam.currentValue) : null;
  if (fl === null || fu === null) return { ok: false, detail: family + ' quota in ' + region + ' unreadable', family, vcpus };
  const cl = cores ? num(cores.limit) : null;
  const cu = cores ? num(cores.currentValue) : null;
  if (fl - fu < vcpus) {
    return {
      ok: false, family, vcpus,
      detail: family + ' in ' + region + ': limit ' + fl + ', used ' + fu + ', need ' + vcpus,
      request: requestLine(region, family, Math.max(10, fu + vcpus)),
    };
  }
  if (cl !== null && cu !== null && cl - cu < vcpus) {
    return {
      ok: false, family, vcpus,
      detail: 'regional vCPUs in ' + region + ': limit ' + cl + ', used ' + cu + ', need ' + vcpus,
      request: requestLine(region, 'cores', Math.max(10, cu + vcpus)),
    };
  }
  return {
    ok: true, family, vcpus,
    detail: family + ' ' + fu + '/' + fl + ' used, +' + vcpus + ' fits' +
      (cl !== null && cu !== null ? ' · regional ' + cu + '/' + cl : ''),
  };
}

function checkCapacity(region, vmSize) {
  return evalCapacity(region, vmSize, readCapacity(region, vmSize));
}

module.exports = { readCapacity, evalCapacity, checkCapacity };

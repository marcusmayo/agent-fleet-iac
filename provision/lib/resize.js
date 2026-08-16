'use strict';
// resize.js — change an agent VM's size in place, as an attested act.
//
// The 24/7 question is a size question: a D2s_v3 that runs only in sessions costs less than a
// B2als_v2 that runs all month, and the reverse once the agent is always on. Resizing keeps
// everything that makes the agent itself -- name, region, identity, front door, tokens, volumes,
// chains -- and changes one thing, so it is the right lane for that decision. Region moves are
// not resizes (a VM cannot change region in place); those are decommission + up + restore.
//
// Gates, in order: contract valid; VM exists; target size offered in the region with quota
// headroom (the same capacity preflight up uses, minus the vCPUs the VM already holds); then
// the attestation. --go: deallocate (a size change needs it), resize, start, read the size back
// from Azure, record it in the contract (so a rebuild deploys the size the agent runs), ledger
// before/after. A read-back that disagrees with the request is a failure, not a success.
const fs = require('fs');
const { c: col, runCapture, which } = require('./util');
const { loadContract } = require('./contract');
const { derive } = require('./derive');
const { checkCapacity } = require('./capacity');
const { resolvePolicyPath, ledger } = require('./policy');

const VMSIZE_RE = /^Standard_[A-Za-z0-9_]{2,40}$/;
function attestSentence(name, size) { return 'I approve resizing ' + name + ' to ' + size; }

const az = (args) => runCapture('az', args);
function currentSize(rg, vm) {
  const r = az(['vm', 'show', '-g', rg, '-n', vm, '--query', 'hardwareProfile.vmSize', '-o', 'tsv']);
  return r.ok ? (r.stdout || '').trim() : '';
}
function powerState(rg, vm) {
  const r = az(['vm', 'get-instance-view', '-g', rg, '-n', vm, '--query', 'instanceView.statuses', '-o', 'json']);
  if (!r.ok) return 'unknown';
  try { const p = JSON.parse(r.stdout || '[]').find((s) => s && String(s.code || '').startsWith('PowerState/')); return p ? p.code.slice('PowerState/'.length) : 'unknown'; } catch { return 'unknown'; }
}
// vCPUs of a size in a region (from list-skus), so headroom is judged net of what the VM holds now
function vcpusOf(region, size) {
  const r = az(['vm', 'list-skus', '-l', region, '--size', size, '--resource-type', 'virtualMachines', '-o', 'json']);
  try { const sku = (JSON.parse(r.stdout || '[]') || []).find((s) => s && s.name === size); const cap = sku && (sku.capabilities || []).find((k) => k.name === 'vCPUs'); return cap ? Number(cap.value) : null; } catch { return null; }
}
// Record the size in the contract file (JSONC): replace an existing "vmSize" value, or insert
// one after "region" (or after "profile" when there is no region), count-asserted. Exported for tests.
function recordSizeInContract(text, size) {
  const has = text.match(/"vmSize"\s*:\s*"[^"]*"/g);
  if (has && has.length === 1) return text.replace(/"vmSize"\s*:\s*"[^"]*"/, '"vmSize": "' + size + '"');
  if (has && has.length > 1) throw new Error('contract has ' + has.length + ' vmSize fields -- edit by hand');
  const anchor = text.match(/("region"\s*:\s*"[^"]*")/) || text.match(/("profile"\s*:\s*"[^"]*")/);
  if (!anchor) throw new Error('contract has no "region" or "profile" field to anchor vmSize after -- edit by hand');
  return text.replace(anchor[1], anchor[1] + ', "vmSize": "' + size + '"');
}

async function runResize(file, opts = {}) {
  console.log(col.cyan('resize' + (opts.go ? ' --go' : ' (plan)') + '  ' + file));
  const res = loadContract(file);
  if (!res.ok) { console.log(col.red('\nContract INVALID:')); for (const e of res.errors) console.log('  - ' + e); return 1; }
  const v = res.value; const d = derive(v);
  const target = (opts.size || '').trim() || v.vmSize || '';
  if (!VMSIZE_RE.test(target)) { console.log(col.red('\nresize: give a target with --size=<Standard_...> (or set vmSize in the contract)')); return 2; }
  const rg = d.azure.resourceGroup, vm = d.azure.vmName;
  if (!which('az')) { console.log(col.red('\naz not found')); return 2; }
  const cur = currentSize(rg, vm);
  const state = cur ? powerState(rg, vm) : 'absent';
  const curCpu = cur ? vcpusOf(v.region, cur) : 0;
  const cap = checkCapacity(v.region, target);
  // capacity.js judges "need" as the target's full vCPUs. A running VM's own cores count in that
  // family's "used" until it is deallocated, so a same-family upsize can read tighter than it is;
  // the lane stays conservative (refuse on FAIL) and says so, rather than second-guessing quota.
  const required = attestSentence(v.name, target);
  console.log(col.bold('\nRESIZE — ' + v.name));
  console.log('  vm              ' + rg + ' / ' + vm + '  ' + (cur ? col.green(cur) : col.red('NOT FOUND')) + col.dim('   ' + state + (curCpu ? '   ' + curCpu + ' vCPU' : '')));
  console.log('  target          ' + target + (cur === target ? col.green('   (already this size)') : ''));
  console.log('  capacity        ' + (cap.ok ? col.green('PASS') : col.red('FAIL')) + ' ' + col.dim(target + ' in ' + v.region + ' — ' + cap.detail));
  if (!cap.ok && cap.request) console.log(col.dim('                  request: ') + cap.request);
  console.log('  contract        ' + (v.vmSize ? 'vmSize ' + v.vmSize : 'no vmSize recorded') + col.dim('  -> --go records ' + target));
  console.log('  attestation     ' + col.dim(required));
  console.log(col.dim('  --go: deallocate -> resize -> start -> read back -> record in contract -> ledger. Region is unchanged; a region move is decommission + up + restore.'));
  if (!opts.go) { console.log(col.yellow('\nplan only — nothing changed. Re-run with --go --attest "' + required + '" to resize.')); return 0; }

  const policyPath = resolvePolicyPath();
  const base = { action: 'agent.resize', key: v.name, vm, region: v.region, from: cur || null, to: target };
  const led = (extra) => { try { return policyPath ? ledger(policyPath, { ...base, ...extra }) : null; } catch { return null; } };
  if ((opts.attest || '').trim() !== required) { led({ phrase: opts.attest || '', outcome: 'refused: attestation mismatch' }); console.log(col.red('\nresize --go REFUSED — attestation must read exactly:')); console.log('  ' + required); return 3; }
  const refuse = (why) => { led({ phrase: opts.attest, outcome: 'refused: ' + why }); console.log(col.red('\nresize --go REFUSED (nothing changed) — ' + why)); return 2; };
  if (!cur) return refuse('VM not found');
  if (cur === target) { led({ phrase: opts.attest, outcome: 'ok (no-op: already ' + target + ')' }); console.log(col.green('\nalready ' + target + ' — no-op, ledgered.')); return 0; }
  if (!cap.ok) return refuse('capacity: ' + cap.detail + (cap.request ? '  request: ' + cap.request : '') + (curCpu ? '  (a running VM\'s own ' + curCpu + ' vCPU count as used in its family until deallocated; for a same-family upsize, request quota or deallocate first)' : ''));
  console.log(col.cyan('\n[1/4] deallocate ' + vm)); let r = az(['vm', 'deallocate', '-g', rg, '-n', vm, '-o', 'none']);
  if (!r.ok) { led({ phrase: opts.attest, outcome: 'failed: deallocate: ' + (r.stderr || '').split('\n')[0] }); console.log(col.red('  deallocate FAILED (ledgered)')); return 1; }
  console.log(col.cyan('[2/4] resize -> ' + target)); r = az(['vm', 'resize', '-g', rg, '-n', vm, '--size', target, '-o', 'none']);
  if (!r.ok) { const why = (r.stderr || '').split('\n')[0]; led({ phrase: opts.attest, outcome: 'failed: resize: ' + why + ' (VM left deallocated at ' + cur + ')' }); console.log(col.red('  resize FAILED (ledgered): ' + why)); console.log(col.dim('  the VM is deallocated at its old size; start it with: az vm start -g ' + rg + ' -n ' + vm)); return 1; }
  console.log(col.cyan('[3/4] start')); r = az(['vm', 'start', '-g', rg, '-n', vm, '-o', 'none']);
  const after = currentSize(rg, vm);
  if (!r.ok) { led({ phrase: opts.attest, after, outcome: 'failed: start: ' + (r.stderr || '').split('\n')[0] + ' (resized to ' + after + ')' }); console.log(col.red('  start FAILED (ledgered) — resized to ' + after + ' but not running')); return 1; }
  if (after !== target) { led({ phrase: opts.attest, after, outcome: 'FAILED: read-back ' + after + ' != ' + target }); console.log(col.red('\nresize read-back mismatch: Azure reports ' + after + ' (ledgered)')); return 1; }
  console.log(col.cyan('[4/4] record + ledger'));
  let recorded = 'not recorded';
  try { const text = fs.readFileSync(file, 'utf8'); const next = recordSizeInContract(text, target); if (next !== text) fs.writeFileSync(file, next); recorded = 'vmSize ' + target + ' in ' + file; }
  catch (e) { recorded = 'contract NOT updated: ' + e.message; }
  const rec = led({ phrase: opts.attest, after, contract: recorded, outcome: 'ok' });
  console.log(col.green('\nresized ' + v.name + ': ' + cur + ' -> ' + after + ', running') + col.dim('  (' + recorded + '; ledgered ' + (rec ? 'ok' : 'NO') + ')'));
  return 0;
}
module.exports = { runResize, recordSizeInContract, attestSentence };

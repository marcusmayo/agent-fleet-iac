'use strict';
// vmrun.js — run a bash script on a fleet VM through the Azure guest agent (no network path,
// no SSH), the way every hardened-VM debug and restore already works. The script travels as
// a temp file (@file), so shell metacharacters never meet cmd.exe or the az arg parser, and
// the file is removed afterwards. Returns { ok, msg, err } with the VM's combined message.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCapture } = require('./util');

function runOnVm(rg, vm, script, tag) {
  const f = path.join(os.tmpdir(), 'fleet-' + (tag || 'run') + '-' + Date.now().toString(36) + '.sh');
  fs.writeFileSync(f, script, 'utf8');
  try {
    const r = runCapture('az', ['vm', 'run-command', 'invoke', '-g', rg, '-n', vm, '--command-id', 'RunShellScript', '--scripts', '@' + f, '-o', 'json'], { maxBuffer: 16 * 1024 * 1024 });
    let msg = '';
    try { msg = (JSON.parse(r.stdout || '{}').value || []).map((v) => v.message || '').join('\n'); } catch { msg = r.stdout || ''; }
    return { ok: r.ok, msg, err: r.ok ? '' : ((r.stderr || r.stdout || 'run-command failed').split('\n')[0]) };
  } finally { try { fs.unlinkSync(f); } catch { /* best effort */ } }
}
// The [stdout] body of a run-command message, without the [stderr] tail.
function stdoutOf(msg) {
  const m = String(msg || '').match(/\[stdout\]\n([\s\S]*?)\n\[stderr\]/);
  return m ? m[1] : String(msg || '');
}
module.exports = { runOnVm, stdoutOf };

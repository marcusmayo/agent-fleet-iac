'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: (s) => paint('1', s),
  dim: (s) => paint('2', s),
  red: (s) => paint('31', s),
  green: (s) => paint('32', s),
  yellow: (s) => paint('33', s),
  cyan: (s) => paint('36', s),
};

// Run a command capturing output; never throws. `notFound` => binary missing.
function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
    notFound: !!(r.error && r.error.code === 'ENOENT'),
  };
}

function which(bin) {
  const probe = process.platform === 'win32'
    ? runCapture('where', [bin])
    : runCapture('sh', ['-c', `command -v ${bin}`]);
  return probe.ok && probe.stdout ? probe.stdout.split(/\r?\n/)[0].trim() : null;
}

// Locate the fleet repo root: the dir holding bicep/main.bicep AND scripts/deploy.sh.
// Order: $FLEET_DIR, then ascend from cwd, then the CLI's own location (…/provision).
function findFleetRoot() {
  const isRoot = (root) =>
    fs.existsSync(path.join(root, 'bicep', 'main.bicep')) &&
    fs.existsSync(path.join(root, 'scripts', 'deploy.sh'));

  const candidates = [];
  if (process.env.FLEET_DIR) candidates.push(path.resolve(process.env.FLEET_DIR));

  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  candidates.push(path.resolve(__dirname, '..', '..')); // …/provision/lib -> repo root

  for (const root of candidates) {
    if (isRoot(root)) return root;
  }
  return null;
}

module.exports = { c, runCapture, which, findFleetRoot };

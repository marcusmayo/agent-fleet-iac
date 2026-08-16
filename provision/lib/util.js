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
  // Only shell out for Windows .cmd/.bat shims (az, npm, …) which Node can't spawn
  // directly (EINVAL). Real executables (git, where, sh, node) run without a shell —
  // which also avoids the shell-args deprecation warning. Args here are hardcoded/
  // regex-constrained (no shell metacharacters).
  const cmdShim = process.platform === 'win32' && /^(az|npm|npx|yarn|pnpm)$/i.test(cmd);
  const { shell: shellOverride, ...rest } = opts;
  const shell = shellOverride !== undefined ? shellOverride : cmdShim;
  // When shelling (win32 .cmd shims), pass ONE pre-quoted command string -- the args-array +
  // shell:true form is deprecated (DEP0190) because Node only concatenates. Quote any arg with
  // whitespace/metacharacters; our az args are hardcoded/regex-constrained so this is exact.
  const winq = (a) => (/[\s"&|<>^%()]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : a);
  const r = shell
    ? spawnSync([cmd, ...args.map(winq)].join(' '), { encoding: 'utf8', shell: true, ...rest })
    : spawnSync(cmd, args, { encoding: 'utf8', ...rest });
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
  // Direct spawn (no shell) so this doesn't trip the shell-args deprecation warning.
  // where.exe (Windows) and sh (POSIX) are real executables the OS resolves directly.
  const probe = process.platform === 'win32'
    ? spawnSync('where', [bin], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || !probe.stdout) return null;
  return probe.stdout.trim().split(/\r?\n/)[0].trim();
}

// Resolve a usable bash. On Windows, `where bash` usually returns the WSL launcher
// (C:\Windows\System32\bash.exe), which fails when no WSL distro is installed —
// prefer Git-for-Windows bash instead.
function resolveBash() {
  if (process.platform !== 'win32') return which('bash');
  const lines = (arg) => {
    const r = spawnSync('where', [arg], { encoding: 'utf8' });
    return (r.status === 0 && r.stdout)
      ? r.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
  };
  const bashes = lines('bash')
    .filter((s) => !/\\System32\\bash\.exe$/i.test(s) && !/\\WindowsApps\\/i.test(s));
  const gitBash = bashes.find((s) => /\\git\\/i.test(s));
  if (gitBash) return gitBash;
  if (bashes.length) return bashes[0];
  // derive from `where git`:  <git-root>\{cmd|bin}\git.exe  ->  <git-root>\bin\bash.exe
  for (const gitExe of lines('git')) {
    const m = gitExe.match(/^(.*)\\(?:cmd|bin|mingw64\\bin)\\git\.exe$/i);
    if (m) {
      const cand = path.join(m[1], 'bin', 'bash.exe');
      if (fs.existsSync(cand)) return cand;
    }
  }
  return null;
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

// The signed-in deployer's object id, for ledger records: $DEPLOYER_OBJECT_ID wins (the hosted
// plane pins it to its managed identity), else derived once from the az session (a workstation
// shell); null when neither resolves. Cached per process -- one az call at most.
let _deployerId;
function deployerObjectId() {
  if (_deployerId !== undefined) return _deployerId;
  const env = (process.env.DEPLOYER_OBJECT_ID || '').trim();
  if (/^[0-9a-f-]{36}$/i.test(env)) { _deployerId = env; return _deployerId; }
  const r = runCapture('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']);
  const id = r.ok ? (r.stdout || '').trim() : '';
  _deployerId = /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  return _deployerId;
}
module.exports = { c, runCapture, which, resolveBash, findFleetRoot, deployerObjectId };

'use strict';
// core-manifest.js -- fleet-core's manifest is DERIVED from what sync-core vendors, never
// hand-edited. compute() hashes the vendored set of a core dir, check() compares each committed
// manifest with what core/ actually holds, and `--write` regenerates them on any platform.
//
// WHY. A hand-maintained manifest went stale twice in one session: a shared module changed and
// the manifest did not. Every image built from that vendored set failed verify-core inside the
// Docker build while the provisioning lane reported success -- a fresh VM sat at 502 with nothing
// to say for it. The suite now fails on that drift (test/core-manifest.test.js) and sync-core.sh
// refuses to vendor from a stale manifest, so the stamp an agent carries can never disagree with
// the files beside it.
//
// SAME SET, SAME ORDER, SAME NORMALISATION as core/sync-core.sh: *.js, *.yaml, fetch-secret.sh
// and backup-push.sh in core/; *.js in core/gate; sorted bytewise by name; hashed over LF bytes
// (git stores these files LF; a Windows checkout may show CRLF, and the Docker build hashes LF).
// verify-core.sh and sync-core.sh are the tooling, not the payload, and are not listed.
// Change one of the two implementations, change the other.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CORE = path.resolve(__dirname, '..', '..', 'core');

function vendoredSet(dir) {
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.js') || n.endsWith('.yaml') || n === 'fetch-secret.sh' || n === 'backup-push.sh' || n === 'intake-sweep.sh' || n === 'pii-scan.sh')
    .filter((n) => fs.statSync(path.join(dir, n)).isFile())
    .sort(); // bytewise for ASCII names == LC_ALL=C sort
}

function shaLF(file) {
  // byte-exact round trip through latin1, minus every CR -- identical to `tr -d '\r' | sha256sum`
  const raw = fs.readFileSync(file).toString('latin1').replace(/\r/g, '');
  return crypto.createHash('sha256').update(Buffer.from(raw, 'latin1')).digest('hex');
}

function compute(dir) {
  return vendoredSet(dir).map((n) => `${shaLF(path.join(dir, n))}  ${n}`).join('\n') + '\n';
}

function targets(core = CORE) {
  const t = [{ dir: core, file: path.join(core, 'manifest.sha256') }];
  const gate = path.join(core, 'gate');
  if (fs.existsSync(gate)) t.push({ dir: gate, file: path.join(gate, 'manifest.sha256') });
  return t;
}

// -> [{ file, ok, expected, actual, drift: [ 'name: hash differs' | 'name: not in manifest' | 'name: listed but not in core/' ] }]
function check(core = CORE) {
  return targets(core).map((t) => {
    const actual = compute(t.dir);
    const expected = fs.existsSync(t.file) ? fs.readFileSync(t.file, 'utf8').replace(/\r/g, '') : '';
    const parse = (s) => new Map(s.split('\n').filter(Boolean).map((l) => { const m = l.match(/^([0-9a-f]{64})\s+(\S+)$/); return m ? [m[2], m[1]] : ['<malformed line> ' + l, '']; }));
    const want = parse(expected), have = parse(actual);
    const drift = [];
    for (const [n, h] of have) { if (!want.has(n)) drift.push(`${n}: not in manifest`); else if (want.get(n) !== h) drift.push(`${n}: hash differs (core/ has changed since the manifest was written)`); }
    for (const n of want.keys()) if (!have.has(n)) drift.push(`${n}: listed but not in core/`);
    return { file: t.file, ok: actual === expected, expected, actual, drift };
  });
}

function write(core = CORE) {
  const out = [];
  for (const t of targets(core)) { fs.writeFileSync(t.file, compute(t.dir)); out.push(t.file); }
  return out;
}

module.exports = { compute, check, write, vendoredSet, shaLF, CORE };

if (require.main === module) {
  const arg = process.argv[2] || '--check';
  if (arg === '--write') {
    for (const f of write()) console.log('wrote ' + path.relative(process.cwd(), f));
    process.exit(0);
  }
  let rc = 0;
  for (const r of check()) {
    const rel = path.relative(process.cwd(), r.file);
    if (r.ok) console.log('OK    ' + rel);
    else { rc = 1; console.log('STALE ' + rel); for (const d of r.drift) console.log('        ' + d); }
  }
  if (rc) console.log("regenerate with: node provision/lib/core-manifest.js --write   (or: npm run manifest)");
  process.exit(rc);
}

'use strict';
// The fleet-core manifest is derived from core/, never hand-edited. When a shared module changes
// and the manifest does not, every agent image built from the vendored set fails verify-core in
// the Docker build -- and the provisioning lane cannot see it (a fresh VM sits at 502). This is
// the tripwire at the source: the suite fails until the manifests are regenerated and committed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cm = require('../lib/core-manifest');

test('fleet-core manifests equal what core/ holds (regenerate: npm run manifest, then commit)', () => {
  const results = cm.check();
  assert.ok(results.length >= 1, 'no core/ manifest targets found');
  for (const r of results) {
    assert.ok(r.ok, `${path.relative(cm.CORE, r.file)} is stale:\n  ` + r.drift.join('\n  ') +
      '\n  -> node provision/lib/core-manifest.js --write (or `npm run manifest` in provision/), then commit the manifest with the module');
  }
});

test('the check names the drifted module, and --write repairs it (on a scratch copy of core/)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-manifest-'));
  const core = path.join(tmp, 'core');
  fs.cpSync(cm.CORE, core, { recursive: true });
  // a module edit without a manifest edit -- the exact failure that shipped
  const victim = fs.readdirSync(core).find((n) => n.endsWith('.js'));
  fs.appendFileSync(path.join(core, victim), '\n// drift\n');
  const stale = cm.check(core);
  assert.strictEqual(stale[0].ok, false);
  assert.ok(stale[0].drift.some((d) => d.startsWith(victim + ': hash differs')), 'drift names the edited module: ' + JSON.stringify(stale[0].drift));
  // an unlisted new module is drift too
  fs.writeFileSync(path.join(core, 'brand-new-module.js'), "'use strict';\n");
  assert.ok(cm.check(core)[0].drift.some((d) => d === 'brand-new-module.js: not in manifest'));
  // --write repairs both
  cm.write(core);
  assert.ok(cm.check(core).every((r) => r.ok), 'write() regenerates a manifest that check() accepts');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hashes are over LF bytes, so a CRLF working copy agrees with the Docker build', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-manifest-crlf-'));
  const lf = path.join(tmp, 'a.js'), crlf = path.join(tmp, 'b.js');
  fs.writeFileSync(lf, "'use strict';\nmodule.exports = 1;\n");
  fs.writeFileSync(crlf, "'use strict';\r\nmodule.exports = 1;\r\n");
  assert.strictEqual(cm.shaLF(lf), cm.shaLF(crlf));
  fs.rmSync(tmp, { recursive: true, force: true });
});

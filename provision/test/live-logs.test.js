'use strict';
// check --live --logs: when the probe is not 200, the CLI reads the VM itself. The script is a pure
// builder that travels as a file through run-command; these pin what it reads and that it is a
// well-formed shell script (no CR, a shebang, set +e so every section prints even if one fails).
const { test } = require('node:test');
const assert = require('node:assert');
const { logsScript } = require('../lib/live');

test('logs script reads the five things a dead VM has to say, in order', () => {
  const s = logsScript();
  const idx = ['=== cloud-init ===', '=== image build: verdict ===', '=== retry log ===', '=== timers ===', '=== first-boot marker ===', '=== containers ===', '=== cloudflared ==='].map((k) => s.indexOf(k));
  assert.ok(idx.every((i) => i >= 0), 'every section present');
  assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b), 'sections in order');
  for (const p of ['/var/log/agent-image-build.log', '/var/log/agent-bootstrap.log', 'agent-bootstrap-retry.timer', 'agent-backup.timer', 'agent-intake.timer', '/run/agent-firstboot', 'docker ps -a', 'cloudflared']) assert.ok(s.includes(p), 'reads ' + p);
});

test('logs script is a well-formed payload: shebang, set +e, LF only, ends with a newline', () => {
  const s = logsScript();
  assert.ok(s.startsWith('#!/bin/bash\nset +e\n'));
  assert.ok(!s.includes('\r'));
  assert.ok(s.endsWith('\n'));
});

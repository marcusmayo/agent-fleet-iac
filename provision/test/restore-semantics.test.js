'use strict';
// `restore` extracts a snapshot OVER the live volumes: everything in the snapshot is written
// back, and anything created since it is left alone. That is a merge, not a return to a point in
// time, and the word restore implies the second. Proven on a fresh agent — a marker written after
// the snapshot survived a restore that reported OK, with both containers healthy and the front
// door at 200, so nothing an operator could see would have told them.
//
// Merge is the right default for volumes that hold notes: a recovery must never silently delete
// work written since the backup. So the behaviour stays and the wording carries the burden. These
// assertions exist so that a future edit which quietly makes restore destructive has to delete a
// test that says, in words, why it is not.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'backup.js'), 'utf8');
const SWEEP = fs.readFileSync(path.resolve(__dirname, '..', '..', 'core', 'intake-sweep.sh'), 'utf8');

test('restore states MERGE before it runs, not after', () => {
  const at = SRC.indexOf('MERGE, not a rewind');
  assert.ok(at > 0, 'the warning must exist');
  assert.ok(at < SRC.indexOf("'--command-id', 'RunShellScript', '--scripts', '/usr/local/bin/agent-backup restore '"),
    'and it must print before the VM is touched, not in the result line');
});

test('the warning says what survives, in the operator\'s terms', () => {
  assert.match(SRC, /anything created SINCE that snapshot is KEPT/);
  assert.match(SRC, /fleetctl backup list \$\{name\}/, 'and points at how to see what is being overlaid');
});

test('success does not claim a rewind either', () => {
  assert.match(SRC, /written back over the live volumes/);
  assert.match(SRC, /this was a merge, not a rewind/);
});

test('nothing in the lane deletes volume contents before extracting', () => {
  // the day someone adds an rm -rf to make restore destructive, this fails and they have to
  // read the comment above rather than discover the change with a year of notes in the volume
  assert.ok(!/rm -rf/.test(SWEEP), 'the sweep must not delete volume contents');
  assert.ok(!/--clean/.test(SRC), 'a destructive mode would be a separate attested flag, not a default');
});

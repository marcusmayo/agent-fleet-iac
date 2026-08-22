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

test('the destructive mode is a separate ATTESTED flag, never the default', () => {
  assert.ok(!/rm -rf/.test(SWEEP), 'the sweep must not delete volume contents');
  assert.match(SRC, /--clean/, 'the flag exists');
  assert.match(SRC, /I approve a clean restore of/, 'behind an exact typed phrase');
  // the refusal must cost nothing: it fires before the store is even resolved, so a wrong
  // phrase never spends an az call, let alone touches a VM. Scoped to runRestore's own body --
  // resolveAccount appears all over the file, and a whole-file index proved nothing.
  const body = SRC.slice(SRC.indexOf('function runRestore'));
  assert.ok(body.indexOf('I approve a clean restore of') < body.indexOf('resolveAccount()'),
    'the gate precedes every az touch in runRestore');
});

test('clean order on the VM: verify the archive, stop, wipe -- wiping first would turn a corrupt download into total loss', () => {
  const VM = fs.readFileSync(path.resolve(__dirname, '..', '..', 'core', 'backup-push.sh'), 'utf8');
  const verify = VM.indexOf('tar -tzf');
  const stop = VM.indexOf('docker stop');
  const wipe = VM.indexOf('-mindepth 1 -delete');
  assert.ok(verify > 0 && stop > 0 && wipe > 0, 'all three steps exist');
  assert.ok(verify < stop && stop < wipe, 'verify -> stop -> wipe, in that order only');
  assert.strictEqual(VM.split('-mindepth 1 -delete').length - 1, 1, 'the wipe exists ONLY in the clean branch');
  assert.match(VM, /nothing was touched/, 'and an unreadable archive says so before anything moved');
});

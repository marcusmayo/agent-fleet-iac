'use strict';
// plane.js -- which control plane is this? One rule for every lane that names something after
// the plane: enroll's token (<plane>-<agent>) and, now, up's (the plane that provisions an agent
// holds a token named for itself, so provisioning from the hosted plane leaves nothing for enroll
// to add and a workstation up is labelled as what it is). $AEGIS_PLANE wins, else the hostname,
// slugged to a safe label.
const os = require('node:os');

function planeName(explicit) {
  const raw = (explicit || process.env.AEGIS_PLANE || os.hostname() || 'aegis').toLowerCase();
  return raw.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'aegis';
}

module.exports = { planeName };

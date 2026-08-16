'use strict';
// aegis-contract.js — validator for the CONTROL PLANE contract.
//
// Deliberately separate from contract.js. That one describes an agent: it carries a
// profile, joins the fleet registry, counts against maxFleet, and can be torn down by
// `fleetctl decommission`. None of that should be true of the thing that issues those
// commands, and the cheapest way to guarantee it is to give the control plane a contract
// the agent lane cannot parse and an agent contract this lane will refuse.
//
// The refusal runs both ways on purpose (see loadAegisContract): handing an agent
// contract to `aegis up`, or this one to `up`, fails loudly rather than doing something
// surprising with a file that looks close enough.
const fs = require('fs');
const path = require('path');
const { stripJsonc } = require('./jsonc');

const SUPPORTED_CONTRACT_MAJOR = 1;
const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[12][0-9]|3[0-2])$/;
const HTTPS_GIT_RE = /^https:\/\/\S+\.git$/;
const REGION_RE = /^[a-z]+[a-z0-9]*$/;
const SIZE_RE = /^Standard_[A-Za-z0-9_]+$/;

// northcentralus + B2ats_v2: the B-series is NotAvailableForSubscription across
// eastus/eastus2/westus2 on this subscription, and the control plane runs 24/7 so the
// difference compounds. See bicep/modules/aegis-vm.bicep for the full reasoning.
const DEFAULTS = {
  region: 'northcentralus',
  vmSize: 'Standard_B2ats_v2',
  domain: 'keel-pm.com',
  port: 7070,
  adminUsername: 'aegisadmin',
  fleetVaultName: 'kv-keelpm-aegis',
  aegisRepoUrl: `https://github.com/${process.env.FLEET_REPO_ORG || 'marcusmayo'}/aegis.git`,
  fleetRepoUrl: `https://github.com/${process.env.FLEET_REPO_ORG || 'marcusmayo'}/agent-fleet-iac.git`,
};

const ALLOWED_KEYS = new Set([
  'contract', 'name', 'domain', 'region', 'vmSize', 'adminUsername',
  'sshAccessCidr', 'aegisRepoUrl', 'fleetRepoUrl', 'repoRef', 'fleetVaultName',
  'operatorEmail', 'notes',
]);

function loadAegisContract(file) {
  const errors = [];
  let raw;
  try {
    raw = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return { ok: false, errors: [`cannot read/parse ${file}: ${e.message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['contract must be a JSON object'] };
  }

  // Refuse an AGENT contract outright. `profile` is the agent lane's required field and
  // has no meaning here; silently ignoring it would let someone deploy a control plane
  // while believing they were deploying an agent.
  if ('profile' in raw) {
    return { ok: false, errors: [
      'this looks like an AGENT contract ("profile" is set). The control plane has its own ' +
      'contract and its own lane -- use `fleetctl up` for agents, `fleetctl aegis up` for the ' +
      'control plane. They are separate so fleet caps and decommission cannot reach the control plane.',
    ] };
  }

  for (const k of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(k)) errors.push(`unknown key ${JSON.stringify(k)} (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
  }

  const major = Number(raw.contract);
  if (!Number.isInteger(major)) errors.push('"contract" is required (integer major version)');
  else if (major !== SUPPORTED_CONTRACT_MAJOR) errors.push(`"contract": ${major} unsupported (this CLI honours ${SUPPORTED_CONTRACT_MAJOR})`);

  const name = raw.name;
  if (typeof name !== 'string') errors.push('"name" is required (string)');
  else if (!NAME_RE.test(name)) errors.push(`"name" must match ${NAME_RE} (got ${JSON.stringify(name)})`);

  const domain = raw.domain === undefined || raw.domain === '' ? DEFAULTS.domain : raw.domain;
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) errors.push(`"domain" invalid (got ${JSON.stringify(raw.domain)})`);

  const region = raw.region === undefined || raw.region === '' ? DEFAULTS.region : raw.region;
  if (typeof region !== 'string' || !REGION_RE.test(region)) errors.push(`"region" invalid (got ${JSON.stringify(raw.region)})`);

  const vmSize = raw.vmSize === undefined || raw.vmSize === '' ? DEFAULTS.vmSize : raw.vmSize;
  if (typeof vmSize !== 'string' || !SIZE_RE.test(vmSize)) errors.push(`"vmSize" must look like Standard_* (got ${JSON.stringify(raw.vmSize)})`);

  const adminUsername = raw.adminUsername === undefined || raw.adminUsername === '' ? DEFAULTS.adminUsername : raw.adminUsername;
  if (typeof adminUsername !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(adminUsername)) errors.push(`"adminUsername" invalid (got ${JSON.stringify(raw.adminUsername)})`);

  // Empty is the HARDENED default: no public IP, tunnel-only, no SSH path at all.
  const sshAccessCidr = raw.sshAccessCidr === undefined ? '' : raw.sshAccessCidr;
  if (typeof sshAccessCidr !== 'string' || (sshAccessCidr !== '' && !CIDR_RE.test(sshAccessCidr))) {
    errors.push(`"sshAccessCidr" must be empty (hardened, no public IP) or a CIDR (got ${JSON.stringify(raw.sshAccessCidr)})`);
  }

  const aegisRepoUrl = raw.aegisRepoUrl === undefined || raw.aegisRepoUrl === '' ? DEFAULTS.aegisRepoUrl : raw.aegisRepoUrl;
  if (typeof aegisRepoUrl !== 'string' || !HTTPS_GIT_RE.test(aegisRepoUrl)) errors.push(`"aegisRepoUrl" must be an https .git URL (got ${JSON.stringify(raw.aegisRepoUrl)})`);
  const fleetRepoUrl = raw.fleetRepoUrl === undefined || raw.fleetRepoUrl === '' ? DEFAULTS.fleetRepoUrl : raw.fleetRepoUrl;
  if (typeof fleetRepoUrl !== 'string' || !HTTPS_GIT_RE.test(fleetRepoUrl)) errors.push(`"fleetRepoUrl" must be an https .git URL (got ${JSON.stringify(raw.fleetRepoUrl)})`);

  const repoRef = raw.repoRef === undefined ? '' : raw.repoRef;
  if (typeof repoRef !== 'string' || (repoRef !== '' && !/^[A-Za-z0-9._\/-]{1,100}$/.test(repoRef))) errors.push(`"repoRef" invalid (got ${JSON.stringify(raw.repoRef)})`);

  const fleetVaultName = raw.fleetVaultName === undefined || raw.fleetVaultName === '' ? DEFAULTS.fleetVaultName : raw.fleetVaultName;
  if (typeof fleetVaultName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(fleetVaultName)) errors.push(`"fleetVaultName" invalid (got ${JSON.stringify(raw.fleetVaultName)})`);

  const operatorEmail = raw.operatorEmail === undefined ? '' : raw.operatorEmail;
  if (typeof operatorEmail !== 'string' || (operatorEmail !== '' && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(operatorEmail))) {
    errors.push(`"operatorEmail" invalid (got ${JSON.stringify(raw.operatorEmail)})`);
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      contract: major, name, domain, region, vmSize, adminUsername, sshAccessCidr,
      aegisRepoUrl, fleetRepoUrl, repoRef, fleetVaultName, operatorEmail,
      hostname: `${name}.${domain}`,
      port: DEFAULTS.port,
      resourceGroup: `rg-${name}`,
      vmName: `${name}-vm`,
    },
  };
}

module.exports = { loadAegisContract, DEFAULTS, SUPPORTED_CONTRACT_MAJOR };

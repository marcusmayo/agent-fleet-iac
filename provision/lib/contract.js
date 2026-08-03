'use strict';
const fs = require('node:fs');
const { stripJsonc } = require('./jsonc');

// The CLI is the ONLY interpreter of this contract. It validates every input it
// renders from. Bump SUPPORTED_CONTRACT_MAJOR only when the CLI can honour it.
const SUPPORTED_CONTRACT_MAJOR = 1;

// Deployable profiles = what main.bicep + deploy.sh actually accept. (Note:
// cloudflare-provision.ps1 also lists 'atlas', but Atlas is not yet a deployable
// bicep profile, so it is intentionally NOT in this allowlist.)
const PROFILES = ['castor', 'keel'];

const DEFAULT_DOMAIN = 'keel-pm.com';
const DEFAULT_PORT = 8443;
const DEFAULT_REGION = 'eastus2';

// Per-profile default build repo — mirrors the defaults in the bicepparam files.
const PROFILE_REPO = {
  castor: 'https://github.com/marcusmayo/castor.git',
  keel: 'https://github.com/marcusmayo/keel-portfolio-management.git',
};

// Matches deploy.sh, cloudflare-provision.ps1, and main.bicep (2-24, lowercase,
// starts with a letter). We add a trailing-hyphen reject (stricter, DNS-clean) —
// anything we accept those tools also accept, so there is no downstream mismatch.
const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[12][0-9]|3[0-2])$/;
const HTTPS_GIT_RE = /^https:\/\/\S+\.git$/;
const REGION_RE = /^[a-z]+[a-z0-9]*$/;

const ALLOWED_KEYS = new Set([
  'contract', 'name', 'profile', 'domain',
  'webchatPort', 'region', 'sshCidr', 'repoUrl', 'repoRef',
]);

// Keys that smell like a secret or key material must never live in the (committed)
// contract. Secrets come from env/vault at run time.
const SECRET_KEY_RE = /(token|secret|password|passwd|credential|api[-_ ]?key|private[-_ ]?key)/i;

function validateContract(raw) {
  const errors = [];
  const warnings = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['contract must be a JSON object'], warnings, value: null };
  }

  // Unknown / secret-shaped keys (fail closed on both; secrets get a louder message).
  for (const k of Object.keys(raw)) {
    if (ALLOWED_KEYS.has(k)) continue;
    if (SECRET_KEY_RE.test(k)) {
      errors.push(`secret-shaped key "${k}" is not allowed — secrets live in env/vault, never the contract file`);
    } else {
      errors.push(`unknown key "${k}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
    }
  }

  // contract major — fail closed on an unknown (higher) major.
  if (!('contract' in raw)) {
    errors.push('missing "contract" (compat floor; must be an integer >= 1)');
  } else if (!Number.isInteger(raw.contract) || raw.contract < 1) {
    errors.push(`"contract" must be an integer >= 1 (got ${JSON.stringify(raw.contract)})`);
  } else if (raw.contract > SUPPORTED_CONTRACT_MAJOR) {
    errors.push(`contract major ${raw.contract} not supported by this CLI (supports <= ${SUPPORTED_CONTRACT_MAJOR}) — upgrade the CLI`);
  }

  // name (required)
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    errors.push('"name" is required (string)');
  } else if (!NAME_RE.test(raw.name)) {
    errors.push('"name" must be lowercase, start with a letter, and be 2-24 chars of [a-z0-9-]');
  } else if (raw.name.endsWith('-')) {
    errors.push('"name" must not end with a hyphen (invalid DNS label)');
  }

  // profile (required)
  if (typeof raw.profile !== 'string') {
    errors.push('"profile" is required (string)');
  } else if (!PROFILES.includes(raw.profile)) {
    errors.push(`"profile" must be one of ${PROFILES.join(' | ')} (got ${JSON.stringify(raw.profile)})`);
  }

  // domain (optional; "" or omitted -> default)
  let domain = DEFAULT_DOMAIN;
  if ('domain' in raw && raw.domain !== '') {
    if (typeof raw.domain !== 'string' || !DOMAIN_RE.test(raw.domain)) {
      errors.push(`"domain" must be a valid domain name (got ${JSON.stringify(raw.domain)})`);
    } else {
      domain = raw.domain;
    }
  }

  // webchatPort (optional -> default)
  let webchatPort = DEFAULT_PORT;
  if ('webchatPort' in raw) {
    if (!Number.isInteger(raw.webchatPort) || raw.webchatPort < 1 || raw.webchatPort > 65535) {
      errors.push(`"webchatPort" must be an integer 1-65535 (got ${JSON.stringify(raw.webchatPort)})`);
    } else {
      webchatPort = raw.webchatPort;
    }
  }

  // region (optional; "" or omitted -> default)
  let region = DEFAULT_REGION;
  if ('region' in raw && raw.region !== '') {
    if (typeof raw.region !== 'string' || !REGION_RE.test(raw.region)) {
      errors.push(`"region" must be an Azure region string like "eastus2" (got ${JSON.stringify(raw.region)})`);
    } else {
      region = raw.region;
    }
  }

  // sshCidr (optional; "" = hardened, no public IP)
  let sshCidr = '';
  if ('sshCidr' in raw) {
    if (typeof raw.sshCidr !== 'string') {
      errors.push('"sshCidr" must be a string ("" = hardened, no public IP)');
    } else if (raw.sshCidr !== '' && !CIDR_RE.test(raw.sshCidr)) {
      errors.push(`"sshCidr" must be "" or a CIDR like 203.0.113.5/32 (got ${JSON.stringify(raw.sshCidr)})`);
    } else {
      sshCidr = raw.sshCidr;
    }
  }

  // repoUrl (optional override; "" or omitted -> per-profile default)
  let repoUrl = '';
  let repoUrlIsDefault = true;
  if ('repoUrl' in raw && raw.repoUrl !== '') {
    if (typeof raw.repoUrl !== 'string' || !HTTPS_GIT_RE.test(raw.repoUrl)) {
      errors.push(`"repoUrl" must be an https git URL ending in .git (got ${JSON.stringify(raw.repoUrl)})`);
    } else {
      repoUrl = raw.repoUrl;
      repoUrlIsDefault = false;
    }
  }

  // repoRef (optional; "" = default-branch HEAD)
  let repoRef = '';
  if ('repoRef' in raw) {
    if (typeof raw.repoRef !== 'string') {
      errors.push('"repoRef" must be a string (branch, tag, or commit sha; "" = default-branch HEAD)');
    } else {
      repoRef = raw.repoRef;
    }
  }

  if (errors.length) return { ok: false, errors, warnings, value: null };

  if (repoUrlIsDefault) repoUrl = PROFILE_REPO[raw.profile];

  const value = {
    contract: raw.contract,
    name: raw.name,
    profile: raw.profile,
    domain,
    webchatPort,
    region,
    sshCidr,
    repoUrl,
    repoUrlIsDefault,
    repoRef,
  };
  return { ok: true, errors, warnings, value };
}

function loadContract(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`cannot read contract file "${file}": ${e.message}`], warnings: [], value: null, file };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (e) {
    return { ok: false, errors: [`contract "${file}" is not valid JSONC: ${e.message}`], warnings: [], value: null, file };
  }
  const res = validateContract(parsed);
  res.file = file;
  return res;
}

module.exports = {
  validateContract,
  loadContract,
  SUPPORTED_CONTRACT_MAJOR,
  PROFILES,
  DEFAULT_DOMAIN,
  DEFAULT_PORT,
  DEFAULT_REGION,
  PROFILE_REPO,
};

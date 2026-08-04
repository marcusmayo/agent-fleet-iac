'use strict';
const crypto = require('node:crypto');
const { c, runCapture } = require('./util');

// RFC 4648 base32 (no padding) — matches the shape the VM bootstrap/authenticator expect.
function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

// Generate a fresh TOTP secret + otpauth URI (160-bit, SHA1/6-digit/30s = authenticator default).
function genTotp(issuer, account) {
  const secret = base32(crypto.randomBytes(20));
  const label = encodeURIComponent(`${issuer}:${account}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

// Best-effort ASCII QR via python3+qrcode (same renderer the VM uses); null if unavailable.
function tryRenderQr(uri) {
  const py = [
    'import sys',
    'try:',
    '    import qrcode',
    '    q=qrcode.QRCode(border=1); q.add_data(sys.argv[1]); q.make(); q.print_ascii(invert=True)',
    'except Exception:',
    '    sys.exit(3)',
  ].join('\n');
  const r = runCapture('python3', ['-c', py, uri]);
  return (r.ok && r.stdout && r.stdout.trim()) ? r.stdout.replace(/\s+$/, '') : null;
}

// The single Key Vault in the agent's resource group (rg-<agent>).
function resolveVault(agent) {
  const rg = `rg-${agent}`;
  const r = runCapture('az', ['keyvault', 'list', '-g', rg, '--query', '[0].name', '-o', 'tsv']);
  if (r.notFound) return { ok: false, reason: 'az CLI not found on PATH' };
  if (!r.ok) return { ok: false, reason: (r.stderr || 'az returned non-zero').split('\n')[0] };
  const name = (r.stdout || '').trim();
  if (!name) return { ok: false, reason: `no Key Vault in ${rg} — is the agent deployed with the vault bicep (step 1)?` };
  return { ok: true, vault: name, rg };
}

function setSecret(vault, name, value) {
  const r = runCapture('az', ['keyvault', 'secret', 'set', '--vault-name', vault, '--name', name, '--value', value, '-o', 'none']);
  return r.ok ? { ok: true } : { ok: false, reason: (r.stderr || 'az returned non-zero').split('\n')[0] };
}

// Seed an agent's Key Vault with the three bootstrap secrets. The two API keys come
// from the environment (never CLI args, so they don't land in shell history / process
// listings as fleetctl args); the TOTP secret is generated here at seed time and the
// operator enrolls it (agent identity is read-only — it fetches, never writes).
// Re-running rotates the TOTP and overwrites the keys (key rotation / re-enrollment).
function runSetSecrets(agent) {
  console.log(c.cyan(`set-secrets  ${agent}`));

  const anth = process.env.ANTHROPIC_API_KEY || '';
  const ork = process.env.OPENROUTER_API_KEY || '';
  const problems = [];
  if (!anth) problems.push('ANTHROPIC_API_KEY not set in the environment');
  if (!ork) problems.push('OPENROUTER_API_KEY not set in the environment');
  else if (!/^sk-or-/.test(ork)) problems.push('OPENROUTER_API_KEY must start with sk-or- (placeholder or wrong key)');
  if (problems.length) {
    console.log(c.red('\nset-secrets ABORT — nothing written:'));
    for (const p of problems) console.log('  - ' + p);
    console.log(c.dim('\n  Set them in the environment first, then re-run:'));
    console.log(c.dim('    $env:ANTHROPIC_API_KEY = "sk-ant-..."'));
    console.log(c.dim('    $env:OPENROUTER_API_KEY = "sk-or-..."'));
    return 2;
  }

  const v = resolveVault(agent);
  if (!v.ok) { console.log(c.red('\nset-secrets ABORT — ' + v.reason)); return 2; }
  console.log(c.dim(`  vault: ${v.vault}  (resource group ${v.rg})`));

  const { secret: totp, uri } = genTotp('Keel', agent);
  const writes = [
    ['totp-secret', totp],
    ['anthropic-api-key', anth],
    ['openrouter-api-key', ork],
  ];
  for (const [name, value] of writes) {
    const r = setSecret(v.vault, name, value);
    if (!r.ok) { console.log(c.red(`\nset-secrets FAILED writing '${name}': ${r.reason}`)); return 1; }
    console.log(c.green(`  set ${name}`));
  }

  console.log(c.bold(`\nTOTP enrollment for ${agent} — add to your authenticator app:`));
  const qr = tryRenderQr(uri);
  if (qr) console.log('\n' + qr + '\n');
  console.log(c.dim('  otpauth URI:   ') + uri);
  console.log(c.dim('  manual secret: ') + totp);
  console.log(c.green('\nset-secrets OK — vault seeded. The agent fetches these at first boot (no prompt).'));
  console.log(c.dim(`  Verify: az keyvault secret list --vault-name ${v.vault} --query "[].name" -o tsv`));
  return 0;
}

module.exports = { base32, genTotp, resolveVault, setSecret, runSetSecrets };

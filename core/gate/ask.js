const { execFileSync } = require('child_process');
const { prepareForEgress, rehydrate } = require('./gate');
const { record } = require('./audit');

// ask(prompt, options) -> { status, output } | { status: 'BLOCKED', notification }
function ask(prompt, options = {}) {
  const prep = prepareForEgress(prompt, {}, options);

  if (prep.status === 'BLOCKED') {
    record({
      action: 'EGRESS',
      status: 'BLOCKED',
      rule_types: prep.hits.map(h => h.type),
      redaction: 'BLOCKED',
    });
    return { status: 'BLOCKED', notification: prep.notification };
  }

  // Send ONLY the redacted text to the model via claude -p
  let raw;
  try {
    raw = execFileSync('claude', ['-p', prep.redacted], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    record({ action: 'EGRESS', status: 'ERROR', redaction: prep.status, error: e.message.slice(0,120) });
    return { status: 'ERROR', output: 'Model call failed: ' + e.message };
  }

  // Re-hydrate the response locally
  const output = rehydrate(raw, prep.mapState);

  // Audit: metadata only, never content
  const counts = prep.mapState.counters || {};
  record({
    action: 'EGRESS',
    status: prep.status,                 // OK or OVERRIDE
    model: 'claude-code',
    entity_counts: counts,
    override_rule_types: (prep.overrideHits || []).map(h => h.type),
    redaction: prep.status === 'OVERRIDE' ? 'ATTESTED_OVERRIDE' : 'TOKENIZED',
  });

  return { status: prep.status, output };
}

module.exports = { ask };

// CLI usage: node ask.js "your prompt"
if (require.main === module) {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt) { console.error('Usage: node ask.js "prompt"'); process.exit(1); }
  const r = ask(prompt);
  if (r.status === 'BLOCKED') {
    console.log(r.notification);
    process.exit(2);
  }
  console.log(r.output);
}

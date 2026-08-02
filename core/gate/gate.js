const { redact } = require('./redact');
const { checkTripwire } = require('./tripwire');

// Format a block notification the operator can act on.
function formatBlock(hits, text) {
  const lines = ['🛑 EGRESS BLOCKED — nothing was sent to the model.', ''];
  lines.push('Triggered by:');
  for (const h of hits) {
    const snippet = h.location >= 0
      ? text.slice(Math.max(0, h.location - 20), h.location + 30).replace(/\n/g, ' ')
      : '(config error)';
    lines.push(`  • ${h.type} rule "${h.rule}" at position ${h.location}`);
    if (h.location >= 0) lines.push(`    context: ...${snippet}...`);
  }
  lines.push('');
  lines.push('Resolution options:');
  lines.push('  1. EDIT   — remove/rephrase the flagged content and resubmit');
  lines.push('  2. OVERRIDE — proceed once, logged as an attested exception');
  lines.push('  3. ABORT  — cancel this request');
  return lines.join('\n');
}

// Prepare text for egress. Returns either a block, or redacted text + mapState.
// options.allowOverride = true bypasses the tripwire ONCE (still logged upstream).
function prepareForEgress(text, mapState = {}, options = {}) {
  const trip = checkTripwire(text);

  if (trip.blocked && !options.allowOverride) {
    return {
      status: 'BLOCKED',
      hits: trip.hits,
      notification: formatBlock(trip.hits, text),
    };
  }

  const r = redact(text, mapState);
  return {
    status: options.allowOverride && trip.blocked ? 'OVERRIDE' : 'OK',
    redacted: r.redacted,
    overrideHits: options.allowOverride ? trip.hits : [],
    mapState: { map: r.map, counters: r.counters, reverse: r.reverse },
  };
}

// Restore real values in a model response using the session map.
function rehydrate(text, mapState = {}) {
  const map = mapState.map || {};
  let out = text;
  // Replace longer tokens first to avoid [PERSON_1] vs [PERSON_10] collisions
  const tokens = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const tok of tokens) {
    out = out.split(tok).join(map[tok]);
  }
  return out;
}

module.exports = { prepareForEgress, rehydrate };

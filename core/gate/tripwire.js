const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, 'never-egress.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    // Fail closed: if the config can't be read, block everything.
    return { block_terms: [], block_patterns: [], _loadError: e.message };
  }
}

// Returns { blocked: bool, hits: [{type, rule, location}] }
function checkTripwire(text) {
  const cfg = loadConfig();
  const hits = [];

  if (cfg._loadError) {
    return { blocked: true, hits: [{ type: 'CONFIG_ERROR', rule: cfg._loadError, location: -1 }] };
  }

  for (const term of (cfg.block_terms || [])) {
    if (!term) continue;
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if (idx !== -1) hits.push({ type: 'TERM', rule: term, location: idx });
  }

  for (const pat of (cfg.block_patterns || [])) {
    if (!pat) continue;
    let re;
    try { re = new RegExp(pat, 'gi'); } catch { continue; }
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ type: 'PATTERN', rule: pat, location: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return { blocked: hits.length > 0, hits };
}

module.exports = { checkTripwire };

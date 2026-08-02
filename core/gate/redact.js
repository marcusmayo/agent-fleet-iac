const nlp = require('compromise');

// Order matters: AMOUNT before others; longer matches first.
const PATTERNS = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  PHONE: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  // Match $2.5 million / $2,500,000.00 / $2.5M as a whole unit
  AMOUNT: /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|trillion|thousand|M|B|K|bn|mn))?/gi,
};

function redact(text, mapState = {}) {
  const map = mapState.map || {};
  const counters = mapState.counters || { PERSON: 0, ORG: 0, EMAIL: 0, PHONE: 0, AMOUNT: 0 };
  const reverse = mapState.reverse || {};

  function tokenFor(type, value) {
    const key = value.trim();
    if (reverse[key]) return reverse[key];
    counters[type] += 1;
    const token = `[${type}_${counters[type]}]`;
    map[token] = key;
    reverse[key] = token;
    return token;
  }

  let out = text;

  // Structured patterns: EMAIL, PHONE, AMOUNT
  for (const [type, re] of Object.entries(PATTERNS)) {
    out = out.replace(re, (m) => tokenFor(type, m));
  }

  // NLP entities: people and organizations (best-effort broad pass)
  const doc = nlp(out);
  const people = doc.people().out('array');
  const orgs = doc.organizations().out('array');
  const places = doc.places().out('array');

  // Replace longer strings first to avoid partial overlaps
  const ents = [
    ...people.map(v => ['PERSON', v]),
    ...orgs.map(v => ['ORG', v]),
  ].filter(([, v]) => v && v.trim().length > 1)
   .sort((a, b) => b[1].length - a[1].length);

  for (const [type, v] of ents) {
    if (out.includes(v)) out = out.split(v).join(tokenFor(type, v));
  }

  return { redacted: out, map, counters, reverse };
}

module.exports = { redact };

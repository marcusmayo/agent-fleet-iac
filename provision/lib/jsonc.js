'use strict';
// Minimal, dependency-free JSONC -> JSON normaliser.
// Strips // line comments, /* block */ comments, and trailing commas, while
// leaving the contents of string literals untouched (so a "," or "]" inside a
// string is never mangled). Output is fed straight to JSON.parse.
//
// A hand-written state machine is used deliberately over a regex: regexes can't
// safely tell a comment/comma apart from the same characters inside a string.

function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let pendingComma = false; // a ',' seen outside a string, not yet emitted

  // Emit a deferred comma unless the next real token closes a container.
  const flushComma = (nextChar) => {
    if (pendingComma) {
      if (nextChar !== '}' && nextChar !== ']') out += ',';
      pendingComma = false;
    }
  };

  while (i < n) {
    const ch = text[i];

    // Whitespace: preserve (keeps line numbers roughly aligned for parse errors);
    // does not resolve a pending comma.
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      out += ch;
      i++;
      continue;
    }

    // Line comment.
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      continue;
    }

    // Block comment.
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // consume the closing */
      continue;
    }

    // String literal — copy verbatim, honouring escapes.
    if (ch === '"') {
      flushComma(ch);
      out += ch;
      i++;
      while (i < n) {
        const s = text[i];
        if (s === '\\') {
          out += s;
          if (i + 1 < n) {
            out += text[i + 1];
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        out += s;
        i++;
        if (s === '"') break; // closing quote
      }
      continue;
    }

    // Comma outside a string — defer until we see the next real token.
    if (ch === ',') {
      pendingComma = true;
      i++;
      continue;
    }

    // Any other significant character.
    flushComma(ch);
    out += ch;
    i++;
  }
  // A trailing comma at EOF is simply dropped (pendingComma left unflushed).
  return out;
}

module.exports = { stripJsonc };

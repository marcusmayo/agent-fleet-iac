'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { stripJsonc } = require('../lib/jsonc');

const parse = (s) => JSON.parse(stripJsonc(s));

test('strips line comments', () => {
  assert.deepStrictEqual(parse('{ "a": 1 // hi\n }'), { a: 1 });
});

test('strips block comments', () => {
  assert.deepStrictEqual(parse('{ "a": /* x */ 1 }'), { a: 1 });
});

test('strips trailing comma in object', () => {
  assert.deepStrictEqual(parse('{ "a": 1, }'), { a: 1 });
});

test('strips trailing comma in array', () => {
  assert.deepStrictEqual(parse('[1, 2, ]'), [1, 2]);
});

test('strips trailing comma before a nested close', () => {
  assert.deepStrictEqual(parse('{ "a": [1, ], }'), { a: [1] });
});

test('preserves a comma inside a string', () => {
  assert.deepStrictEqual(parse('{ "a": "x,]" }'), { a: 'x,]' });
});

test('preserves comment-like text inside a string', () => {
  assert.deepStrictEqual(parse('{ "a": "http://x // y" }'), { a: 'http://x // y' });
});

test('preserves an escaped quote inside a string', () => {
  assert.deepStrictEqual(parse('{ "a": "he said \\"hi\\"" }'), { a: 'he said "hi"' });
});

test('leaves clean JSON untouched', () => {
  const j = { a: 1, b: [2, 3], c: { d: 'e' } };
  assert.deepStrictEqual(parse(JSON.stringify(j)), j);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cf = require('../lib/cfapi');

const ACCT = 'acct123';
const APP = 'app456';

test('create service token: POST to service_tokens with name', () => {
  const r = cf.reqCreateServiceToken(ACCT, 'aegis-bosun');
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, `${cf.CF_API}/accounts/${ACCT}/access/service_tokens`);
  assert.deepStrictEqual(r.body, { name: 'aegis-bosun' });
});

test('list apps: GET accounts/{acct}/access/apps', () => {
  const r = cf.reqListApps(ACCT);
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.url, `${cf.CF_API}/accounts/${ACCT}/access/apps`);
});

test('service-auth policy CREATE: non_identity + service_token include, POST inline on app', () => {
  const r = cf.reqServiceAuthPolicy(ACCT, APP, 'aegis-bosun', 'tok-1', null);
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, `${cf.CF_API}/accounts/${ACCT}/access/apps/${APP}/policies`);
  assert.strictEqual(r.body.decision, 'non_identity');           // the gotcha: NOT 'allow'
  assert.deepStrictEqual(r.body.include, [{ service_token: { token_id: 'tok-1' } }]);
  assert.strictEqual(r.body.name, 'aegis-bosun');
});

test('service-auth policy UPDATE: PUT to existing policy id', () => {
  const r = cf.reqServiceAuthPolicy(ACCT, APP, 'aegis-bosun', 'tok-1', 'pol-9');
  assert.strictEqual(r.method, 'PUT');
  assert.strictEqual(r.url, `${cf.CF_API}/accounts/${ACCT}/access/apps/${APP}/policies/pol-9`);
  assert.strictEqual(r.body.decision, 'non_identity');
});

test('list policies: GET on the app', () => {
  const r = cf.reqListPolicies(ACCT, APP);
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.url, `${cf.CF_API}/accounts/${ACCT}/access/apps/${APP}/policies`);
});

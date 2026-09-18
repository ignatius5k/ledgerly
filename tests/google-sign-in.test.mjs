import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTokenSignIn } from '../google-sign-in.mjs';

function setup() {
  let callbacks, request, timeout, script;
  const environment = {
    document: { createElement: () => ({}), head: { appendChild: value => { script = value; } } },
    setTimeout: fn => { timeout = fn; return 1; }, clearTimeout: () => {},
    google: { accounts: { oauth2: { initTokenClient: options => {
      callbacks = options;
      return { requestAccessToken: options => { request = options; } };
    } } } },
  };
  const signIn = createGoogleTokenSignIn(environment, 'test-client');
  return { environment, signIn, callbacks: () => callbacks, request: () => request, timeout: () => timeout(), script: () => script };
}

test('Google opens synchronously from the tap and returns a credential without helper storage', async () => {
  const s = setup();
  const result = s.signIn();
  assert.deepEqual(s.request(), { prompt: 'select_account' });
  assert.equal(s.callbacks().scope, 'openid email profile');
  assert.equal(s.callbacks().include_granted_scopes, false);
  await assert.rejects(s.signIn(), { code: 'auth/cancelled-popup-request' });
  s.callbacks().callback({ access_token: 'synthetic-token' });
  assert.equal(await result, 'synthetic-token');
});

test('Blocked, cancelled, denied and expired attempts can be retried; late callbacks cannot complete a retry', async () => {
  const s = setup();
  let result = s.signIn();
  s.callbacks().error_callback({ type: 'popup_failed_to_open' });
  await assert.rejects(result, { code: 'auth/popup-blocked' });
  result = s.signIn();
  s.callbacks().callback({ error: 'access_denied' });
  await assert.rejects(result, { code: 'auth/popup-closed-by-user' });
  result = s.signIn();
  const old = s.callbacks();
  s.timeout();
  await assert.rejects(result, { code: 'auth/timeout' });
  result = s.signIn();
  old.callback({ access_token: 'stale-token' });
  s.callbacks().callback({ access_token: 'current-token' });
  assert.equal(await result, 'current-token');
});

test('Unavailable Google library fails visibly without starting the broken Firebase popup fallback', async () => {
  const s = setup();
  delete s.environment.google;
  await assert.rejects(s.signIn(), { code: 'auth/google-loading' });
  s.script().onerror();
  await assert.rejects(s.signIn(), /could not load/);
});

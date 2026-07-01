import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { makeGetAccessToken } from '../src/auth.js';

const realFetch = global.fetch;
const ENV_KEYS = ['GTM_ACCESS_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
let saved;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  global.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('static token', () => {
  test('returns GTM_ACCESS_TOKEN verbatim, without any network call', async () => {
    process.env.GTM_ACCESS_TOKEN = 'STATIC';
    global.fetch = async () => {
      throw new Error('static-token path must not hit the network');
    };
    const get = makeGetAccessToken();
    assert.equal(await get('anyone@example.com'), 'STATIC');
  });
});

describe('refresh token', () => {
  test('exchanges the refresh token and caches until near expiry', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_REFRESH_TOKEN = 'ref';

    let calls = 0;
    global.fetch = async (url) => {
      assert.match(String(url), /oauth2\.googleapis\.com\/token/);
      calls += 1;
      return new Response(JSON.stringify({ access_token: `FRESH${calls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const get = makeGetAccessToken();
    assert.equal(await get(), 'FRESH1');
    assert.equal(await get(), 'FRESH1'); // served from cache — no second exchange
    assert.equal(calls, 1);
  });

  test('returns null when no credentials are configured', async () => {
    const get = makeGetAccessToken();
    assert.equal(await get(), null);
  });

  test('surfaces a refresh failure as an error', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_REFRESH_TOKEN = 'bad';
    global.fetch = async () => new Response('invalid_grant', { status: 400 });

    const get = makeGetAccessToken();
    await assert.rejects(get(), /Token refresh failed: 400/);
  });
});

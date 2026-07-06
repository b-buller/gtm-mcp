import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { makeGetAccessToken, tokensPath } from '../src/auth.js';

const realFetch = global.fetch;
const ENV_KEYS = ['GTM_ACCESS_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'XDG_CONFIG_HOME'];
let saved;
let configDir;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Hermetic config dir: never read a real ~/.config/gtm-mcp/tokens.json.
  configDir = mkdtempSync(join(tmpdir(), 'gtm-mcp-test-'));
  process.env.XDG_CONFIG_HOME = configDir;
});

afterEach(() => {
  global.fetch = realFetch;
  rmSync(configDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const writeStoredTokens = (tokens) => {
  mkdirSync(join(configDir, 'gtm-mcp'), { recursive: true });
  writeFileSync(join(configDir, 'gtm-mcp', 'tokens.json'), JSON.stringify(tokens));
};

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

describe('stored login tokens (npm run login)', () => {
  test('tokensPath respects XDG_CONFIG_HOME', () => {
    assert.equal(tokensPath(), join(configDir, 'gtm-mcp', 'tokens.json'));
  });

  test('exchanges the stored refresh token and caches', async () => {
    writeStoredTokens({ client_id: 'file-id', client_secret: 'file-sec', refresh_token: 'file-ref', email: 'me@x.com' });

    let calls = 0;
    let lastBody;
    global.fetch = async (url, init) => {
      calls += 1;
      lastBody = new URLSearchParams(init.body);
      return new Response(JSON.stringify({ access_token: `STORED${calls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const get = makeGetAccessToken();
    assert.equal(await get(), 'STORED1');
    assert.equal(await get(), 'STORED1'); // cached
    assert.equal(calls, 1);
    assert.equal(lastBody.get('client_id'), 'file-id');
    assert.equal(lastBody.get('refresh_token'), 'file-ref');
    assert.equal(lastBody.get('grant_type'), 'refresh_token');
  });

  test('explicit env credentials beat the stored file', async () => {
    writeStoredTokens({ client_id: 'file-id', client_secret: 'file-sec', refresh_token: 'file-ref' });
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-sec';
    process.env.GOOGLE_REFRESH_TOKEN = 'env-ref';

    let lastBody;
    global.fetch = async (url, init) => {
      lastBody = new URLSearchParams(init.body);
      return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await makeGetAccessToken()();
    assert.equal(lastBody.get('client_id'), 'env-id');
  });

  test('failed refresh of a stored login hints to re-run login', async () => {
    writeStoredTokens({ client_id: 'file-id', client_secret: 'file-sec', refresh_token: 'revoked' });
    global.fetch = async () => new Response('invalid_grant', { status: 400 });

    await assert.rejects(makeGetAccessToken()(), /npm run login/);
  });

  test('incomplete stored file is ignored (returns null, no network)', async () => {
    writeStoredTokens({ client_id: 'file-id' }); // missing secret + refresh token
    global.fetch = async () => {
      throw new Error('must not hit the network');
    };

    assert.equal(await makeGetAccessToken()(), null);
  });
});

describe('multi-account store', () => {
  const twoAccounts = {
    default: 'a@x.com',
    accounts: {
      'a@x.com': { client_id: 'id-a', client_secret: 'sec-a', refresh_token: 'ref-a' },
      'b@y.com': { client_id: 'id-b', client_secret: 'sec-b', refresh_token: 'ref-b' },
    },
  };

  const captureFetch = () => {
    const bodies = [];
    global.fetch = async (url, init) => {
      bodies.push(new URLSearchParams(init.body));
      return new Response(JSON.stringify({ access_token: `T${bodies.length}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return bodies;
  };

  test('selects the account matching the email, caches per account', async () => {
    writeStoredTokens(twoAccounts);
    const bodies = captureFetch();
    const get = makeGetAccessToken();

    const tokenB = await get('b@y.com');
    const tokenA = await get('a@x.com');
    assert.notEqual(tokenA, tokenB);
    assert.equal(await get('B@Y.com'), tokenB); // cached, case-insensitive
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].get('refresh_token'), 'ref-b');
    assert.equal(bodies[1].get('refresh_token'), 'ref-a');
  });

  test('omitted email uses the default account', async () => {
    writeStoredTokens(twoAccounts);
    const bodies = captureFetch();
    await makeGetAccessToken()();
    assert.equal(bodies[0].get('refresh_token'), 'ref-a');
  });

  test('unknown email fails with the list of connected accounts', async () => {
    writeStoredTokens(twoAccounts);
    await assert.rejects(makeGetAccessToken()('nobody@z.com'), /a@x\.com, b@y\.com/);
  });

  test('legacy flat file still works when its email is requested', async () => {
    writeStoredTokens({ client_id: 'file-id', client_secret: 'file-sec', refresh_token: 'file-ref', email: 'Me@X.com' });
    const bodies = captureFetch();
    await makeGetAccessToken()('me@x.com');
    assert.equal(bodies[0].get('refresh_token'), 'file-ref');
  });
});

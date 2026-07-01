import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { buildTools, callTool } from '../src/gtm.js';

/**
 * The engine has exactly two external dependencies: `fetch` (to pull the GTM
 * discovery doc + call the REST API) and an injected `getAccessToken(email)`
 * token provider. We stub both so the suite is offline and deterministic.
 *
 * `global.fetch` is replaced at module load — before any test runs — so the
 * lazily-built, process-cached registry locks onto our fixture discovery doc.
 * Node's test runner isolates each test FILE in its own process, so this global
 * patch never leaks into other suites.
 */
const SCOPE = {
  readonly: 'https://www.googleapis.com/auth/tagmanager.readonly',
  edit: 'https://www.googleapis.com/auth/tagmanager.edit.containers',
  publish: 'https://www.googleapis.com/auth/tagmanager.publish',
};

const DISCOVERY_FIXTURE = {
  baseUrl: 'https://tagmanager.googleapis.com/',
  resources: {
    accounts: {
      methods: {
        list: { id: 'tagmanager.accounts.list', httpMethod: 'GET', path: 'tagmanager/v2/accounts', parameters: { pageToken: { location: 'query' } }, scopes: [SCOPE.readonly] },
        get: { id: 'tagmanager.accounts.get', httpMethod: 'GET', path: 'tagmanager/v2/{+path}', parameters: { path: { location: 'path', required: true } }, scopes: [SCOPE.readonly] },
      },
      resources: {
        containers: {
          methods: {
            combine: { id: 'tagmanager.accounts.containers.combine', httpMethod: 'POST', path: 'tagmanager/v2/{+path}:combine', parameters: { path: { location: 'path', required: true }, containerId: { location: 'query' }, settingSource: { location: 'query' } }, scopes: [SCOPE.edit] },
          },
          resources: {
            versions: {
              methods: {
                publish: { id: 'tagmanager.accounts.containers.versions.publish', httpMethod: 'POST', path: 'tagmanager/v2/{+path}:publish', parameters: { path: { location: 'path', required: true }, fingerprint: { location: 'query' } }, scopes: [SCOPE.publish] },
              },
            },
            workspaces: {
              resources: {
                tags: {
                  methods: {
                    list: { id: 'tagmanager.accounts.containers.workspaces.tags.list', httpMethod: 'GET', path: 'tagmanager/v2/{+parent}/tags', parameters: { parent: { location: 'path', required: true }, pageToken: { location: 'query' } }, scopes: [SCOPE.readonly] },
                    get: { id: 'tagmanager.accounts.containers.workspaces.tags.get', httpMethod: 'GET', path: 'tagmanager/v2/{+path}', parameters: { path: { location: 'path', required: true } }, scopes: [SCOPE.readonly] },
                    create: { id: 'tagmanager.accounts.containers.workspaces.tags.create', httpMethod: 'POST', path: 'tagmanager/v2/{+parent}/tags', parameters: { parent: { location: 'path', required: true } }, request: { $ref: 'Tag' }, scopes: [SCOPE.edit] },
                    delete: { id: 'tagmanager.accounts.containers.workspaces.tags.delete', httpMethod: 'DELETE', path: 'tagmanager/v2/{+path}', parameters: { path: { location: 'path', required: true } }, scopes: [SCOPE.edit] },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** Captured non-discovery (GTM REST API) requests, newest last. */
let apiCalls = [];

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('$discovery')) {
    return new Response(JSON.stringify(DISCOVERY_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  apiCalls.push({ url: u, method: opts.method, auth: opts.headers?.Authorization, contentType: opts.headers?.['Content-Type'], body: opts.body });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

/** Token provider stub: returns `token` for any email (null => no credential). */
function tokenProvider(token = 'TKN') {
  return async () => token;
}

// Guardrail configs for mutation tests (default server config is read-only).
const WRITES = { enableWrites: true };
const DELETES = { enableDeletes: true };
const PUBLISH = { enablePublish: true };

const lastCall = () => apiCalls[apiCalls.length - 1];
const textOf = (res) => res.content[0].text;

beforeEach(() => {
  apiCalls = [];
});

describe('buildTools', () => {
  test('groups discovery methods into one tool per resource (gtm_<segment>)', async () => {
    const tools = await buildTools();
    assert.deepEqual(tools.map((t) => t.name), ['gtm_accounts', 'gtm_containers', 'gtm_tags', 'gtm_versions']);
  });

  test('gtm_tags exposes operation enum, path ids, body, and confirm; requires only operation (email optional)', async () => {
    const tags = (await buildTools()).find((t) => t.name === 'gtm_tags');
    assert.deepEqual(tags.inputSchema.required, ['operation']);
    assert.deepEqual(tags.inputSchema.properties.operation.enum, ['create', 'delete', 'get', 'list']);
    for (const p of ['email', 'accountId', 'containerId', 'workspaceId', 'tagId', 'body', 'confirm', 'query']) {
      assert.ok(p in tags.inputSchema.properties, `missing prop ${p}`);
    }
  });
});

describe('callTool — path building', () => {
  test('list builds the collection URL ({+parent}/tags) and sends the bearer token', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'list', email: 'A@B.com', accountId: '6', containerId: '9', workspaceId: '2' });
    assert.equal(res.isError, false);
    assert.equal(lastCall().method, 'GET');
    assert.equal(lastCall().url, 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/6/containers/9/workspaces/2/tags');
    assert.equal(lastCall().auth, 'Bearer TKN');
  });

  test('get builds the item URL ({+path}) with the trailing id', async () => {
    await callTool(tokenProvider(), 'gtm_tags', { operation: 'get', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2', tagId: '33' });
    assert.equal(lastCall().url, 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/6/containers/9/workspaces/2/tags/33');
  });

  test('create POSTs a JSON body (writes enabled)', async () => {
    await callTool(tokenProvider(), 'gtm_tags', { operation: 'create', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2', body: { name: 't' } }, WRITES);
    assert.equal(lastCall().method, 'POST');
    assert.equal(lastCall().contentType, 'application/json');
    assert.equal(lastCall().body, JSON.stringify({ name: 't' }));
  });

  test('custom verbs and query passthrough do not clash with path ids (combine)', async () => {
    await callTool(tokenProvider(), 'gtm_containers', { operation: 'combine', email: 'a@b.com', accountId: '6', containerId: '9', confirm: true, query: { containerId: '77', settingSource: 'current' } }, WRITES);
    assert.equal(lastCall().url, 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/6/containers/9:combine?containerId=77&settingSource=current');
  });
});

describe('callTool — auth', () => {
  test('omitted email still authenticates via the token provider (single-account)', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'list', accountId: '6', containerId: '9', workspaceId: '2' });
    assert.equal(res.isError, false);
    assert.equal(lastCall().auth, 'Bearer TKN');
  });

  test('rejects when the provider returns no token', async () => {
    const res = await callTool(tokenProvider(null), 'gtm_tags', { operation: 'list', email: 'x@y.com', accountId: '6', containerId: '9', workspaceId: '2' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /token/i);
    assert.equal(apiCalls.length, 0);
  });
});

describe('email default (config.gtm.defaultEmail)', () => {
  test('omitted email falls back to the configured default and still sends the bearer token', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'list', accountId: '6', containerId: '9', workspaceId: '2' }, { defaultEmail: 'Default@B.com' });
    assert.equal(res.isError, false);
    assert.equal(lastCall().auth, 'Bearer TKN');
  });

  test('explicit email overrides the configured default', async () => {
    await callTool(tokenProvider(), 'gtm_tags', { operation: 'get', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2', tagId: '7' }, { defaultEmail: 'default@b.com' });
    assert.equal(lastCall().url, 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/6/containers/9/workspaces/2/tags/7');
  });
});

describe('callTool — guardrails', () => {
  test('read operations work without any enable flags (read-only default)', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'list', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2' });
    assert.equal(res.isError, false);
  });

  test('create is blocked by default (writes disabled)', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'create', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2', body: { name: 't' } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /disabled/i);
    assert.equal(apiCalls.length, 0);
  });

  test('delete requires confirm:true (even when deletes enabled)', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'delete', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2', tagId: '33' }, DELETES);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /confirm/i);
    assert.equal(apiCalls.length, 0);
  });

  test('delete is blocked when deletes are disabled, even with confirm', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'delete', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2', tagId: '33', confirm: true });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /disabled/i);
    assert.equal(apiCalls.length, 0);
  });

  test('delete proceeds with confirm:true when enabled', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'delete', email: 'a@b.com', accountId: '6', containerId: '9', workspaceId: '2', tagId: '33', confirm: true }, DELETES);
    assert.equal(res.isError, false);
    assert.equal(lastCall().method, 'DELETE');
    assert.equal(lastCall().url, 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/6/containers/9/workspaces/2/tags/33');
  });

  test('publish requires confirm and the publish flag, then hits the :publish verb', async () => {
    const blocked = await callTool(tokenProvider(), 'gtm_versions', { operation: 'publish', email: 'a@b.com', accountId: '6', containerId: '9', containerVersionId: '5' }, PUBLISH);
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /confirm/i);

    const ok = await callTool(tokenProvider(), 'gtm_versions', { operation: 'publish', email: 'a@b.com', accountId: '6', containerId: '9', containerVersionId: '5', confirm: true }, PUBLISH);
    assert.equal(ok.isError, false);
    assert.equal(lastCall().method, 'POST');
    assert.equal(lastCall().url, 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/6/containers/9/versions/5:publish');
  });

  test('unknown operation for a tool errors without calling the API', async () => {
    const res = await callTool(tokenProvider(), 'gtm_tags', { operation: 'frobnicate', email: 'a@b.com' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /unknown operation/i);
    assert.equal(apiCalls.length, 0);
  });
});

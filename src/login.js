#!/usr/bin/env node
// src/login.js — one-time interactive Google login for gtm-mcp.
//
// Opens a browser, you pick your Google account, and the resulting tokens are
// stored at ~/.config/gtm-mcp/tokens.json (0600). The MCP server picks them up
// automatically — no env vars needed at runtime.
//
// Usage:
//   node src/login.js /path/to/client_secret.json   # OAuth client file from Cloud Console
//   node src/login.js                               # or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env
//
// The OAuth client must be type "Desktop app" (loopback redirect URIs are
// allowed without pre-registration). Scopes default to all four GTM scopes;
// override with GTM_SCOPES (space or comma separated). `openid email` is always
// added so we can record which account was connected.
//
// Zero dependencies: node:http loopback + PKCE (node:crypto) + global fetch.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';

import { tokensPath } from './auth.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.delete.containers',
  'https://www.googleapis.com/auth/tagmanager.publish',
];

function clientCredentials() {
  const file = process.argv[2];
  if (file) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const c = json.installed ?? json.web ?? json; // Console wraps under "installed" (Desktop) or "web"
    if (c.client_id && c.client_secret) return { client_id: c.client_id, client_secret: c.client_secret };
    throw new Error(`No client_id/client_secret found in ${file}`);
  }
  const { GOOGLE_CLIENT_ID: client_id, GOOGLE_CLIENT_SECRET: client_secret } = process.env;
  if (client_id && client_secret) return { client_id, client_secret };
  throw new Error(
    'Usage: node src/login.js /path/to/client_secret.json\n' +
      '(or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)\n' +
      'Create a "Desktop app" OAuth client at https://console.cloud.google.com/apis/credentials'
  );
}

function openBrowser(url) {
  const [bin, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  spawn(bin, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// Loopback server for the OAuth redirect. Resolves with { port, codePromise };
// codePromise settles when Google redirects back (or after a 5 min timeout).
function startCallbackServer(state) {
  return new Promise((resolve, reject) => {
    let settle;
    const codePromise = new Promise((res, rej) => (settle = { res, rej }));

    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const ok = !error && code && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' });
      res.end(
        ok
          ? '<h3>gtm-mcp: logged in. You can close this tab.</h3>'
          : `<h3>gtm-mcp: login failed${error ? ` (${error})` : ''}. Check the terminal.</h3>`
      );
      clearTimeout(timer);
      server.close();
      if (ok) settle.res(code);
      else settle.rej(new Error(error || 'OAuth callback state mismatch'));
    });

    const timer = setTimeout(() => {
      server.close();
      settle.rej(new Error('Timed out waiting for browser login (5 minutes)'));
    }, 5 * 60_000);

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, codePromise }));
  });
}

async function main() {
  const { client_id, client_secret } = clientCredentials();

  // PKCE + CSRF state
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomUUID();

  const { port, codePromise } = await startCallbackServer(state);
  const redirect_uri = `http://127.0.0.1:${port}/callback`;

  const scopes = (
    process.env.GTM_SCOPES ? process.env.GTM_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES
  ).concat(['openid', 'email']);

  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    client_id,
    redirect_uri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // ...even if previously granted
  })}`;

  console.log(`Opening your browser for Google login…\nIf nothing opens, visit:\n\n  ${authUrl}\n`);
  openBrowser(authUrl);

  const code = await codePromise;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id,
      client_secret,
      redirect_uri,
    }),
  });
  if (!res.ok) throw new Error(`Code exchange failed: ${res.status} ${await res.text()}`);
  const tokens = await res.json();
  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh_token. Revoke prior access at https://myaccount.google.com/permissions and retry.'
    );
  }

  // id_token came straight from Google over TLS — decoding without signature
  // verification is fine here, we only display/store the email.
  const email = tokens.id_token
    ? (JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()).email ?? null)
    : null;

  const path = tokensPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ client_id, client_secret, refresh_token: tokens.refresh_token, email }, null, 2)}\n`, {
    mode: 0o600,
  });

  console.log(`Logged in as ${email ?? '(email unknown)'}.`);
  console.log(`Tokens stored at ${path}`);
  console.log('The MCP server will use them automatically — no env vars needed.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

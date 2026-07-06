// src/auth.js
//
// Resolve a Google OAuth access token for the GTM REST API. Three modes,
// first match wins:
//
//   1. Static token — GTM_ACCESS_TOKEN
//        Paste a short-lived access token (~1h). Simplest; you re-mint it when
//        it expires. Good for quick trials.
//
//   2. Refresh token via env — GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
//        Explicit env config beats the stored login below.
//
//   3. Stored login — ~/.config/gtm-mcp/tokens.json, written by `npm run login`
//        (src/login.js). Recommended: one interactive browser login, then the
//        server silently refreshes access tokens from the stored refresh token.
//        Supports multiple connected accounts: run `npm run login` once per
//        Google account, then pass `email` per tool call (or set MCP_GTM_EMAIL
//        as the default) to pick which one to act as.
//
// Modes 2 and 3 share the same refresh exchange and cache access tokens
// (per account) until ~60s before expiry.
//
// tokens.json shapes:
//   legacy (single account): { client_id, client_secret, refresh_token, email }
//   current (multi-account): { default: "a@x.com", accounts: { "a@x.com": { client_id, client_secret, refresh_token } } }

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Where `npm run login` stores tokens (respects XDG_CONFIG_HOME). */
export function tokensPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'gtm-mcp', 'tokens.json');
}

function envCredentials() {
  const { GOOGLE_CLIENT_ID: client_id, GOOGLE_CLIENT_SECRET: client_secret, GOOGLE_REFRESH_TOKEN: refresh_token } =
    process.env;
  if (!client_id || !client_secret || !refresh_token) return null;
  return { client_id, client_secret, refresh_token, stored: false };
}

/** Read tokens.json as a multi-account store; migrates the legacy flat shape in memory. */
export function loadTokenStore() {
  let raw;
  try {
    raw = readFileSync(tokensPath(), 'utf8');
  } catch {
    return null; // not logged in
  }
  const data = JSON.parse(raw);
  if (data.accounts) return data;
  // Legacy single-account file.
  const { client_id, client_secret, refresh_token, email } = data;
  if (!client_id || !client_secret || !refresh_token) return null;
  const key = String(email || 'default').toLowerCase();
  return { default: key, accounts: { [key]: { client_id, client_secret, refresh_token } } };
}

function storedCredentials(email) {
  const store = loadTokenStore();
  if (!store) return null;
  const emails = Object.keys(store.accounts);
  const key = email || store.default || emails[0];
  const acc = store.accounts[key];
  if (!acc) {
    throw new Error(
      `No stored login for '${key}'. Connected accounts: ${emails.join(', ') || '(none)'}. Run \`npm run login\` to connect it.`
    );
  }
  if (!acc.client_id || !acc.client_secret || !acc.refresh_token) return null;
  return { ...acc, stored: true };
}

async function exchangeRefreshToken({ client_id, client_secret, refresh_token, stored }) {
  const body = new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text();
    const hint = stored ? ' — stored login may be expired or revoked; run `npm run login` again' : '';
    throw new Error(`Token refresh failed: ${res.status} ${detail}${hint}`);
  }
  const data = await res.json();
  return { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

/**
 * Build a `getAccessToken(email) -> Promise<string|null>` for the GTM engine.
 * Each instance keeps its own refresh-token cache (no shared module state).
 */
export function makeGetAccessToken() {
  const cache = new Map(); // email ('' = default) -> { token, exp }

  return async function getAccessToken(email) {
    // Static token wins if present — lets you override without touching refresh config.
    if (process.env.GTM_ACCESS_TOKEN) return process.env.GTM_ACCESS_TOKEN;

    const key = String(email || '').trim().toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const creds = envCredentials() ?? storedCredentials(key || undefined);
    if (!creds) return null;
    const fresh = await exchangeRefreshToken(creds);
    cache.set(key, fresh);
    return fresh.token;
  };
}

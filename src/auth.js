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
//
// Modes 2 and 3 share the same refresh exchange and cache the access token
// until ~60s before expiry.
//
// The `email` argument is ignored here (single-account). To support multiple
// connected accounts, swap this file for a provider that keys tokens by email.

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

function storedCredentials() {
  let raw;
  try {
    raw = readFileSync(tokensPath(), 'utf8');
  } catch {
    return null; // not logged in
  }
  const { client_id, client_secret, refresh_token } = JSON.parse(raw);
  if (!client_id || !client_secret || !refresh_token) return null;
  return { client_id, client_secret, refresh_token, stored: true };
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
  let cached = null; // { token, exp }

  return async function getAccessToken(/* email */) {
    // Static token wins if present — lets you override without touching refresh config.
    if (process.env.GTM_ACCESS_TOKEN) return process.env.GTM_ACCESS_TOKEN;

    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const creds = envCredentials() ?? storedCredentials();
    if (!creds) return null;
    cached = await exchangeRefreshToken(creds);
    return cached.token;
  };
}

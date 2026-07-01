// src/auth.js
//
// Resolve a Google OAuth access token for the GTM REST API. Two modes, chosen
// by environment variables:
//
//   1. Static token — GTM_ACCESS_TOKEN
//        Paste a short-lived access token (~1h). Simplest; you re-mint it when
//        it expires. Good for quick trials.
//
//   2. Refresh token — GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
//        Auto-refreshes and caches the access token until ~60s before expiry.
//        Durable; set it once. See README for how to mint a refresh token.
//
// The `email` argument is ignored here (single-account). To support multiple
// connected accounts, swap this file for a provider that keys tokens by email.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function exchangeRefreshToken() {
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  const refresh_token = process.env.GOOGLE_REFRESH_TOKEN;
  if (!client_id || !client_secret || !refresh_token) return null;

  const body = new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
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
    cached = await exchangeRefreshToken();
    return cached?.token ?? null;
  };
}

/**
 * Dropbox token acquisition using OAuth2 refresh token flow.
 * Short-lived access tokens (4h) are auto-refreshed from the long-lived refresh token.
 * In-memory cache per isolate (same pattern as graph-auth.js).
 */

import { logger } from "./logger.js";

let tokenCache = null; // { accessToken, expiresAt }
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

/**
 * Get a Dropbox access token, refreshing automatically if needed.
 * Falls back to a static DROPBOX_ACCESS_TOKEN if refresh vars are not configured.
 *
 * @param {object} env - Cloudflare env bindings
 * @returns {Promise<string>} Access token
 */
export async function getDropboxToken(env) {
  // If we have a valid cached token, return it
  if (tokenCache && Date.now() < tokenCache.expiresAt - REFRESH_BUFFER_MS) {
    return tokenCache.accessToken;
  }

  const appKey = env.DROPBOX_APP_KEY;
  const appSecret = env.DROPBOX_APP_SECRET;
  const refreshToken = env.DROPBOX_REFRESH_TOKEN;

  // If refresh credentials are available, use the refresh flow
  if (appKey && appSecret && refreshToken) {
    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshToken);

    const credentials = btoa(`${appKey}:${appSecret}`);

    logger.debug("Requesting new Dropbox token via refresh flow");

    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dropbox token refresh failed (${res.status}): ${text}`);
    }

    const data = await res.json();

    tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 14400) * 1000,
    };

    logger.debug("Dropbox token refreshed", { expiresIn: data.expires_in });
    return tokenCache.accessToken;
  }

  // Fallback: use static access token (may be expired)
  const staticToken = env.DROPBOX_ACCESS_TOKEN;
  if (!staticToken) {
    throw new Error(
      "Missing Dropbox credentials: set DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN, " +
      "or DROPBOX_ACCESS_TOKEN"
    );
  }

  return staticToken;
}

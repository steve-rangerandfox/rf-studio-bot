/**
 * Canva token acquisition using OAuth2 refresh token flow.
 * Tokens are stored in Workers KV (RF_STORE) under the "config" key.
 * The access token (4h) is auto-refreshed from the stored refresh token.
 *
 * Falls back to static env var (CANVA_ACCESS_TOKEN / CANVA_API_TOKEN)
 * if no KV tokens are available.
 */

import { logger } from "./logger.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

/**
 * Get a Canva access token, refreshing automatically if needed.
 *
 * Priority:
 *   1. KV-stored token (from OAuth flow) — auto-refreshed
 *   2. Static env var (CANVA_ACCESS_TOKEN or CANVA_API_TOKEN)
 *
 * @param {object} env - Cloudflare env bindings (must include RF_STORE KV)
 * @returns {Promise<string>} Access token
 */
export async function getCanvaToken(env) {
  // Try KV-stored token first (from OAuth callback)
  if (env.RF_STORE) {
    try {
      const configRaw = await env.RF_STORE.get("config");
      if (configRaw) {
        const config = JSON.parse(configRaw);

        if (config.apiToken && config.canvaTokenExpiresAt) {
          // Check if token is still valid
          if (Date.now() < config.canvaTokenExpiresAt - REFRESH_BUFFER_MS) {
            return config.apiToken;
          }

          // Token expired or about to expire — try refreshing
          if (config.canvaRefreshToken) {
            logger.debug("Canva token expired, refreshing via OAuth2");
            return await refreshCanvaToken(env, config);
          }
        }
      }
    } catch (err) {
      logger.warn("Failed to read Canva token from KV", { error: err.message });
    }
  }

  // Fallback: static env var
  const staticToken = env.CANVA_ACCESS_TOKEN || env.CANVA_API_TOKEN;
  if (staticToken) {
    return staticToken;
  }

  throw new Error(
    "Missing Canva credentials: complete the OAuth flow at /api/canva-authorize, " +
    "or set CANVA_ACCESS_TOKEN (or CANVA_API_TOKEN)"
  );
}

/**
 * Refresh the Canva access token using the stored refresh token.
 *
 * @param {object} env - Cloudflare env bindings
 * @param {object} config - Current config from KV
 * @returns {Promise<string>} New access token
 */
async function refreshCanvaToken(env, config) {
  const clientId = env.CANVA_CLIENT_ID;
  const clientSecret = env.CANVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Cannot refresh Canva token: CANVA_CLIENT_ID and CANVA_CLIENT_SECRET must be set"
    );
  }

  const res = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.canvaRefreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canva token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Update KV with new tokens
  config.apiToken = data.access_token;
  if (data.refresh_token) {
    config.canvaRefreshToken = data.refresh_token;
  }
  config.canvaTokenExpiresAt = Date.now() + (data.expires_in * 1000);
  config.updatedAt = new Date().toISOString();

  await env.RF_STORE.put("config", JSON.stringify(config));

  logger.debug("Canva token refreshed", { expiresIn: data.expires_in });

  return data.access_token;
}

/**
 * Canva OAuth token management.
 * Provides getValidToken() which auto-refreshes expired tokens.
 *
 * Canva access tokens expire after ~4 hours. This module checks
 * expiration and uses the stored refresh token to get a new one.
 */

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

/**
 * Get a valid Canva API token, refreshing if necessary.
 *
 * @param {object} env — Cloudflare Workers environment with RF_STORE KV
 * @returns {Promise<string>} valid access token
 * @throws {Error} if no token exists or refresh fails
 */
export async function getValidToken(env) {
  const configRaw = await env.RF_STORE.get("config");
  if (!configRaw) throw new Error("Not configured");
  const config = JSON.parse(configRaw);

  const token = config.apiToken || env.CANVA_ACCESS_TOKEN;
  if (!token) throw new Error("Missing API token");

  // Check if token needs refresh
  const expiresAt = config.canvaTokenExpiresAt || 0;
  const needsRefresh = Date.now() > (expiresAt - REFRESH_BUFFER_MS);

  if (!needsRefresh) {
    return token; // Token is still valid
  }

  // Token expired or about to expire — try to refresh
  const refreshToken = config.canvaRefreshToken;
  if (!refreshToken) {
    await debugTokenLog(env, "SKIP_REFRESH: no refreshToken in config");
    return token;
  }

  const clientId = env.CANVA_CLIENT_ID;
  const clientSecret = env.CANVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    await debugTokenLog(env, `SKIP_REFRESH: missing creds clientId=${!!clientId} clientSecret=${!!clientSecret}`);
    return token;
  }

  await debugTokenLog(env, `REFRESHING: token expired at ${new Date(expiresAt).toISOString()}, refreshToken length=${refreshToken.length}`);

  const refreshRes = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!refreshRes.ok) {
    const errText = await refreshRes.text();
    await debugTokenLog(env, `REFRESH_FAILED: ${refreshRes.status} ${errText}`);
    throw new Error(`Token refresh failed (${refreshRes.status}): ${errText}`);
  }

  const tokenData = await refreshRes.json();

  // Update config with new tokens
  config.apiToken = tokenData.access_token;
  if (tokenData.refresh_token) {
    config.canvaRefreshToken = tokenData.refresh_token;
  }
  config.canvaTokenExpiresAt = Date.now() + (tokenData.expires_in * 1000);
  config.updatedAt = new Date().toISOString();

  await env.RF_STORE.put("config", JSON.stringify(config));

  await debugTokenLog(env, `REFRESH_OK: new token length=${tokenData.access_token.length}, expires_in=${tokenData.expires_in}s`);

  return tokenData.access_token;
}

async function debugTokenLog(env, msg) {
  try {
    const raw = await env.RF_STORE.get("token_debug_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ t: new Date().toISOString(), msg });
    while (logs.length > 50) logs.shift();
    await env.RF_STORE.put("token_debug_logs", JSON.stringify(logs), { expirationTtl: 3600 });
  } catch (_) {}
}

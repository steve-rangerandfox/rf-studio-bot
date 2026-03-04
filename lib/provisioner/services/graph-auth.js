/**
 * Microsoft Graph token acquisition using client credentials flow.
 * Uses native fetch (no axios). Receives env as parameter (no process.env).
 * In-memory cache per isolate.
 */

import { logger } from "./logger.js";

let tokenCache = null; // { accessToken, expiresAt }
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

/**
 * Get a Microsoft Graph access token using client credentials.
 * @param {object} env - Cloudflare env bindings
 * @returns {Promise<string>} Access token
 */
export async function getGraphToken(env) {
  if (tokenCache && Date.now() < tokenCache.expiresAt - REFRESH_BUFFER_MS) {
    return tokenCache.accessToken;
  }

  // Accept AZURE_, GRAPH_, or TEAMS_ prefixed env var names.
  // Fallback order: AZURE_ → GRAPH_ → TEAMS_ (the Teams bot app often has
  // the same Graph permissions, so reuse its credentials if no separate
  // Azure AD app is configured).
  const tenantId = env.AZURE_TENANT_ID || env.GRAPH_TENANT_ID || env.TEAMS_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID || env.GRAPH_CLIENT_ID || env.TEAMS_APP_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET || env.GRAPH_CLIENT_SECRET || env.TEAMS_APP_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing Azure AD environment variables: set AZURE_TENANT_ID (or GRAPH_TENANT_ID), " +
      "AZURE_CLIENT_ID (or GRAPH_CLIENT_ID), AZURE_CLIENT_SECRET (or GRAPH_CLIENT_SECRET). " +
      "Alternatively, TEAMS_APP_ID / TEAMS_APP_SECRET / TEAMS_TENANT_ID will be used as fallback."
    );
  }

  console.log(`[graph-auth] Using client_id=${clientId.slice(0, 8)}... tenant=${tenantId.slice(0, 8)}...`);

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", "https://graph.microsoft.com/.default");

  logger.debug("Requesting new Graph token");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token acquisition failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  logger.debug("Graph token acquired", { expiresIn: data.expires_in });

  return tokenCache.accessToken;
}

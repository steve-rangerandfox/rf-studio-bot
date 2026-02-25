/**
 * Initiate the Canva OAuth2 PKCE authorization flow.
 * GET /api/canva-authorize — Generates a PKCE challenge, stores the verifier
 * in KV, and redirects to Canva's authorization page.
 *
 * Protected by ADMIN_PIN to prevent unauthorized access.
 */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  // Auth check
  const pin = url.searchParams.get("pin") || request.headers.get("x-admin-pin");
  if (env.ADMIN_PIN && pin !== env.ADMIN_PIN) {
    return Response.json({ error: "Unauthorized. Pass ?pin=YOUR_ADMIN_PIN" }, { status: 401 });
  }

  const clientId = env.CANVA_CLIENT_ID;
  if (!clientId) {
    return Response.json({ error: "CANVA_CLIENT_ID not set" }, { status: 500 });
  }

  // Generate PKCE code verifier and challenge
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64url(verifierBytes);

  const challengeBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = base64url(new Uint8Array(challengeBuffer));

  // Store verifier in KV for the callback to retrieve
  await env.RF_STORE.put("canva_code_verifier", codeVerifier, { expirationTtl: 600 });

  // Build scopes from what the integration has configured
  const scopes = [
    "app:read", "app:write",
    "asset:read", "asset:write",
    "design:content:read", "design:content:write",
    "design:meta:read",
    "folder:read", "folder:write",
    "folder:permission:read", "folder:permission:write",
  ];

  const redirectUri = `${url.origin}/api/canva-callback`;

  const authParams = new URLSearchParams({
    code_challenge_method: "s256",
    response_type: "code",
    client_id: clientId,
    scope: scopes.join(" "),
    code_challenge: codeChallenge,
    redirect_uri: redirectUri,
  });

  const authUrl = `https://www.canva.com/api/oauth/authorize?${authParams.toString()}`;

  return Response.redirect(authUrl, 302);
}

/** Base64url encode a Uint8Array (no padding). */
function base64url(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1] || 0;
    const c = bytes[i + 2] || 0;
    result += chars[a >> 2];
    result += chars[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) result += chars[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) result += chars[c & 63];
  }
  return result;
}

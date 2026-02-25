// OAuth initiation endpoint for Canva Connect API
// Generates PKCE code_verifier/code_challenge and redirects to Canva authorization

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const clientId = env.CANVA_CLIENT_ID;
  if (!clientId) {
    return new Response("CANVA_CLIENT_ID not configured", { status: 500 });
  }

  // Generate PKCE code_verifier (random 43-128 char string)
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const codeVerifier = base64URLEncode(array);

  // Generate code_challenge = base64url(sha256(code_verifier))
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const codeChallenge = base64URLEncode(new Uint8Array(digest));

  // Store code_verifier in KV for the callback to use
  await env.RF_STORE.put("canva_code_verifier", codeVerifier, { expirationTtl: 600 }); // 10 min TTL

  // Build the authorization URL
  const redirectUri = `${url.origin}/api/canva-callback`;
  const scopes = "design:content:write design:content:read design:meta:read folder:read folder:write";
  const state = crypto.randomUUID();

  const authUrl = new URL("https://www.canva.com/api/oauth/authorize");
  authUrl.searchParams.set("code_challenge_method", "s256");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("state", state);

  // Use HTML redirect since Cloudflare Pages converts 302 → 200
  const target = authUrl.toString();
  const html = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${target}"><title>Redirecting...</title></head><body><p>Redirecting to Canva... <a href="${target}">Click here</a> if not redirected.</p><script>window.location.href="${target}";</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function base64URLEncode(buffer) {
  let str = "";
  for (const byte of buffer) {
    str += String.fromCharCode(byte);
  }
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

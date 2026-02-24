// OAuth callback handler for Canva Connect API
// This endpoint receives the authorization code after the user authorizes the integration,
// exchanges it for an access token, and stores it in KV.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  if (error) {
    return new Response(renderHTML("Authorization Failed", `<p>Error: ${error}</p><p>${url.searchParams.get("error_description") || ""}</p>`), {
      headers: { "Content-Type": "text/html" },
    });
  }

  if (!code) {
    return new Response(renderHTML("Missing Code", "<p>No authorization code received.</p>"), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Retrieve the code_verifier from KV (stored when the auth flow was initiated)
  const codeVerifier = await env.RF_STORE.get("canva_code_verifier");
  if (!codeVerifier) {
    return new Response(renderHTML("Missing Verifier", "<p>Code verifier not found. Please restart the authorization flow.</p>"), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Exchange the authorization code for tokens
  try {
    const tokenResponse = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: env.CANVA_CLIENT_ID,
        client_secret: env.CANVA_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/canva-callback`,
      }).toString(),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      return new Response(renderHTML("Token Exchange Failed", `<p>Error: ${JSON.stringify(tokenData)}</p>`), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Store the access token and refresh token
    const configRaw = await env.RF_STORE.get("config");
    let config = configRaw ? JSON.parse(configRaw) : {};

    config.apiToken = tokenData.access_token;
    config.canvaRefreshToken = tokenData.refresh_token;
    config.canvaTokenExpiresAt = Date.now() + (tokenData.expires_in * 1000);
    config.updatedAt = new Date().toISOString();

    await env.RF_STORE.put("config", JSON.stringify(config));

    // Clean up the code verifier
    await env.RF_STORE.delete("canva_code_verifier");

    return new Response(renderHTML("Authorization Successful! \u2705", `
      <p>Canva API access token has been saved.</p>
      <p>Token expires in ${Math.round(tokenData.expires_in / 3600)} hours.</p>
      <p>A refresh token has also been saved for automatic renewal.</p>
      <p><a href="/">\u2190 Back to Studio Bot</a></p>
    `), {
      headers: { "Content-Type": "text/html" },
    });
  } catch (err) {
    return new Response(renderHTML("Error", `<p>Failed to exchange token: ${err.message}</p>`), {
      headers: { "Content-Type": "text/html" },
    });
  }
}

function renderHTML(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} - RF Studio Bot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 80px auto; padding: 20px; text-align: center; }
    h1 { color: #333; }
    p { color: #666; line-height: 1.6; }
    a { color: #4f7cff; text-decoration: none; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;
}

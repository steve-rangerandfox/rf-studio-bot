/**
 * Service connectivity diagnostic endpoint.
 * GET /api/test-services — Tests each external service API for auth and connectivity.
 *
 * Protected by ADMIN_PIN env var to prevent public access.
 * Returns JSON with pass/fail status for each service.
 */

export async function onRequestGet(context) {
  const { env, request } = context;

  // Simple auth: require the bot secret as a query param or header
  const url = new URL(request.url);
  const pin = url.searchParams.get("pin") || request.headers.get("x-admin-pin");
  const adminPin = env.ADMIN_PIN;

  if (adminPin && pin !== adminPin) {
    return Response.json({ error: "Unauthorized. Pass ?pin=YOUR_ADMIN_PIN" }, { status: 401 });
  }

  const results = {};

  // Run all tests in parallel
  const tests = [
    testDropbox(env),
    testFrameIo(env),
    testCanva(env),
    testOneDrive(env),
    testClockify(env),
    testFigma(env),
    testNotion(env),
    testBoords(env),
    testElevenLabs(env),
    testAnthropic(env),
    testTeamsBot(env),
  ];

  const testNames = [
    "dropbox", "frameio", "canva", "onedrive", "clockify",
    "figma", "notion", "boords", "elevenlabs", "anthropic", "teams_bot",
  ];

  const settled = await Promise.allSettled(tests);

  for (let i = 0; i < settled.length; i++) {
    const name = testNames[i];
    if (settled[i].status === "fulfilled") {
      results[name] = settled[i].value;
    } else {
      results[name] = {
        status: "error",
        message: settled[i].reason?.message || String(settled[i].reason),
      };
    }
  }

  // Summary
  const total = testNames.length;
  const passed = Object.values(results).filter(r => r.status === "pass").length;
  const missing = Object.values(results).filter(r => r.status === "missing_config").length;
  const failed = total - passed - missing;

  return Response.json({
    summary: `${passed}/${total} passed, ${missing} not configured, ${failed} failed`,
    results,
    timestamp: new Date().toISOString(),
  }, {
    headers: { "Content-Type": "application/json" },
  });
}

// ── Individual service tests ──

async function testDropbox(env) {
  const appKey = env.DROPBOX_APP_KEY;
  const appSecret = env.DROPBOX_APP_SECRET;
  const refreshToken = env.DROPBOX_REFRESH_TOKEN;

  // Prefer refresh flow over static token
  let token;
  if (appKey && appSecret && refreshToken) {
    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshToken);

    const credentials = btoa(`${appKey}:${appSecret}`);
    const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return { status: "fail", step: "token_refresh", code: tokenRes.status, message: text.substring(0, 200) };
    }

    const tokenData = await tokenRes.json();
    token = tokenData.access_token;
  } else if (env.DROPBOX_ACCESS_TOKEN) {
    token = env.DROPBOX_ACCESS_TOKEN;
  } else {
    return { status: "missing_config", message: "DROPBOX_APP_KEY/APP_SECRET/REFRESH_TOKEN (or DROPBOX_ACCESS_TOKEN) not set" };
  }

  const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  const data = await res.json();
  return {
    status: "pass",
    account: data.name?.display_name || data.email || "ok",
    auth: appKey ? "refresh_token" : "static_token",
  };
}

async function testFrameIo(env) {
  if (!env.FRAMEIO_TOKEN) {
    return { status: "missing_config", message: "FRAMEIO_TOKEN not set" };
  }
  const res = await fetch("https://api.frame.io/v2/me", {
    headers: { Authorization: `Bearer ${env.FRAMEIO_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  const data = await res.json();
  return { status: "pass", user: data.name || data.email || "ok" };
}

async function testCanva(env) {
  // Try KV-stored token first (from OAuth flow), then fall back to env vars
  let token = env.CANVA_ACCESS_TOKEN || env.CANVA_API_TOKEN;
  let source = "env";

  if (!token && env.RF_STORE) {
    try {
      const configRaw = await env.RF_STORE.get("config");
      if (configRaw) {
        const config = JSON.parse(configRaw);
        if (config.apiToken) {
          // Check if token needs refresh
          if (config.canvaTokenExpiresAt && Date.now() >= config.canvaTokenExpiresAt - 5 * 60 * 1000) {
            // Try to refresh
            if (config.canvaRefreshToken && env.CANVA_CLIENT_ID && env.CANVA_CLIENT_SECRET) {
              const refreshRes = await fetch("https://api.canva.com/rest/v1/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                  refresh_token: config.canvaRefreshToken,
                  client_id: env.CANVA_CLIENT_ID,
                  client_secret: env.CANVA_CLIENT_SECRET,
                }).toString(),
              });
              if (refreshRes.ok) {
                const refreshData = await refreshRes.json();
                config.apiToken = refreshData.access_token;
                if (refreshData.refresh_token) config.canvaRefreshToken = refreshData.refresh_token;
                config.canvaTokenExpiresAt = Date.now() + (refreshData.expires_in * 1000);
                config.updatedAt = new Date().toISOString();
                await env.RF_STORE.put("config", JSON.stringify(config));
                token = refreshData.access_token;
                source = "kv_refreshed";
              }
            }
          } else {
            token = config.apiToken;
            source = "kv";
          }
        }
      }
    } catch (_) { /* fall through */ }
  }

  if (!token) {
    return { status: "missing_config", message: "CANVA_ACCESS_TOKEN not set and no OAuth token in KV. Visit /api/canva-authorize to connect." };
  }

  const res = await fetch("https://api.canva.com/rest/v1/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  const data = await res.json();
  return { status: "pass", user: data.display_name || data.id || "ok", auth: source };
}

async function testOneDrive(env) {
  // Accept both AZURE_ and GRAPH_ prefixed env var names
  const tenantId = env.AZURE_TENANT_ID || env.GRAPH_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID || env.GRAPH_CLIENT_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET || env.GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    return {
      status: "missing_config",
      message: "AZURE_TENANT_ID (or GRAPH_TENANT_ID) / CLIENT_ID / CLIENT_SECRET not set",
    };
  }
  // Get a Graph token
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", "https://graph.microsoft.com/.default");

  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return { status: "fail", step: "token", code: tokenRes.status, message: text.substring(0, 200) };
  }
  const tokenData = await tokenRes.json();

  // Test Graph API with the token — use drives endpoint (requires Files.ReadWrite.All)
  const driveId = env.ONEDRIVE_DRIVE_ID;
  const graphUrl = driveId
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}`
    : "https://graph.microsoft.com/v1.0/drives";
  const graphRes = await fetch(graphUrl, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!graphRes.ok) {
    const text = await graphRes.text();
    return { status: "fail", step: "graph", code: graphRes.status, message: text.substring(0, 200) };
  }
  const driveData = await graphRes.json();
  const driveName = driveData.name || driveData.value?.[0]?.name || "ok";
  return { status: "pass", drive: driveName };
}

async function testClockify(env) {
  if (!env.CLOCKIFY_API_KEY) {
    return { status: "missing_config", message: "CLOCKIFY_API_KEY not set" };
  }
  const res = await fetch("https://api.clockify.me/api/v1/user", {
    headers: { "X-Api-Key": env.CLOCKIFY_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  const data = await res.json();
  return { status: "pass", user: data.name || data.email || "ok" };
}

async function testFigma(env) {
  const token = env.FIGMA_ACCESS_TOKEN || env.FIGMA_TOKEN;
  if (!token) {
    return { status: "missing_config", message: "FIGMA_TOKEN not set" };
  }

  // Try /v1/me first (needs current_user:read scope)
  const res = await fetch("https://api.figma.com/v1/me", {
    headers: { "X-Figma-Token": token },
  });

  if (res.ok) {
    const data = await res.json();
    return { status: "pass", user: data.handle || data.email || "ok" };
  }

  // If /v1/me fails with scope error, try file endpoint instead
  // (the provisioner only needs file scopes, not current_user:read)
  const templateKey = env.FIGMA_TEMPLATE_FILE_KEY;
  if (res.status === 403 && templateKey) {
    const fileRes = await fetch(`https://api.figma.com/v1/files/${templateKey}?depth=1`, {
      headers: { "X-Figma-Token": token },
    });
    if (fileRes.ok) {
      const fileData = await fileRes.json();
      return {
        status: "pass",
        note: "token works for file operations (no current_user:read scope)",
        file: fileData.name || templateKey,
      };
    }
    const fileText = await fileRes.text();
    return { status: "fail", code: fileRes.status, message: fileText.substring(0, 200) };
  }

  const text = await res.text();
  return { status: "fail", code: res.status, message: text.substring(0, 200) };
}

async function testNotion(env) {
  if (!env.NOTION_TOKEN) {
    return { status: "missing_config", message: "NOTION_TOKEN not set" };
  }
  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  const data = await res.json();
  return { status: "pass", bot: data.name || data.id || "ok" };
}

async function testBoords(env) {
  // Accept both env var names
  const apiKey = env.BOORDS_API_KEY || env.BOORDS_API_TOKEN;
  if (!apiKey) {
    return { status: "missing_config", message: "BOORDS_API_KEY (or BOORDS_API_TOKEN) not set" };
  }
  // Try listing projects as a connectivity test
  const res = await fetch("https://app.boords.com/api/projects", {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
      // User-Agent required to pass Cloudflare bot protection on Boords
      "User-Agent": "RFStudioBot/1.0 (https://rf-studio-bot.pages.dev)",
    },
  });
  if (!res.ok) {
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    // Detect Cloudflare challenge pages
    if (text.includes("challenge-platform") || text.includes("cf-browser-verification")) {
      return {
        status: "fail",
        code: res.status,
        message: "Cloudflare bot protection blocking request (may need browser-based auth or different approach)",
      };
    }
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  const data = await res.json();
  const count = Array.isArray(data) ? data.length :
    (data.data && Array.isArray(data.data) ? data.data.length : "unknown");
  return { status: "pass", projects: count };
}

async function testElevenLabs(env) {
  if (!env.ELEVENLABS_API_KEY) {
    return { status: "missing_config", message: "ELEVENLABS_API_KEY not set" };
  }
  const res = await fetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  const data = await res.json();
  return {
    status: "pass",
    tier: data.subscription?.tier || "unknown",
    characters_remaining: data.subscription?.character_count
      ? `${data.subscription.character_limit - data.subscription.character_count}`
      : "unknown",
  };
}

async function testAnthropic(env) {
  if (!env.ANTHROPIC_API_KEY) {
    return { status: "missing_config", message: "ANTHROPIC_API_KEY not set" };
  }
  // Minimal API call — send a tiny message
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 5,
      messages: [{ role: "user", content: "Say hi" }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  return { status: "pass", model: "claude-haiku-4-5-20251001" };
}

async function testTeamsBot(env) {
  if (!env.TEAMS_APP_ID || !env.TEAMS_APP_SECRET) {
    return { status: "missing_config", message: "TEAMS_APP_ID/TEAMS_APP_SECRET not set" };
  }
  // Get a bot token
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", env.TEAMS_APP_ID);
  params.append("client_secret", env.TEAMS_APP_SECRET);
  params.append("scope", "https://api.botframework.com/.default");

  const res = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: "fail", code: res.status, message: text.substring(0, 200) };
  }
  return { status: "pass", auth: "bot token acquired" };
}

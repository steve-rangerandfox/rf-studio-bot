/**
 * Service connectivity diagnostic endpoint.
 * GET /api/test-services — Tests each external service API for auth and connectivity.
 *
 * Protected by ADMIN_PIN env var to prevent public access.
 * Returns JSON with pass/fail status for each service.
 */

// Per-fetch timeout (seconds) — prevents one slow API from killing the whole worker
const FETCH_TIMEOUT_MS = 10_000;

/** Fetch wrapper with automatic timeout */
async function tfetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;

  // Simple auth: require the bot secret as a query param or header
  const url = new URL(request.url);
  const pin = url.searchParams.get("pin") || request.headers.get("x-admin-pin");
  const adminPin = env.ADMIN_PIN;

  if (adminPin && pin !== adminPin) {
    return Response.json({ error: "Unauthorized. Pass ?pin=YOUR_ADMIN_PIN" }, { status: 401 });
  }

  // Service ID discovery: ?check=discover
  if (url.searchParams.get("check") === "discover") {
    const results = {};
    // Frame.io: list accounts then teams
    try {
      const fHeaders = { Authorization: `Bearer ${env.FRAMEIO_TOKEN}` };
      // Try /v2/me to get account info
      const meRes = await tfetch("https://api.frame.io/v2/me", { headers: fHeaders });
      const me = await meRes.json();
      // Try /v2/accounts/{account_id}/teams
      const acctId = me.account_id;
      let teams = [];
      if (acctId) {
        const tRes = await tfetch(`https://api.frame.io/v2/accounts/${acctId}/teams`, { headers: fHeaders });
        const tData = await tRes.json();
        teams = (Array.isArray(tData) ? tData : []).map(t => ({ id: t.id, name: t.name }));
      }
      results.frameio = {
        currentTeamId: env.FRAMEIO_TEAM_ID || "(not set)",
        accountId: acctId, teams,
      };
    } catch (e) { results.frameio = { error: e.message }; }
    // OneDrive: list drive root children
    try {
      const { getGraphToken } = await import("../../lib/provisioner/services/graph-auth.js");
      const gToken = await getGraphToken(env);
      const driveId = env.ONEDRIVE_DRIVE_ID;
      const oRes = await tfetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root/children?$select=id,name,folder&$top=20`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      const oData = await oRes.json();
      const rootFolders = (oData.value || []).filter(i => i.folder).map(i => ({ id: i.id, name: i.name }));
      // Also list Production subfolder children to find 2026
      const prodFolder = rootFolders.find(f => f.name === "Production");
      let prodChildren = [];
      if (prodFolder) {
        const pRes = await tfetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${prodFolder.id}/children?$select=id,name,folder&$top=20`, {
          headers: { Authorization: `Bearer ${gToken}` },
        });
        const pData = await pRes.json();
        prodChildren = (pData.value || []).filter(i => i.folder).map(i => ({ id: i.id, name: i.name }));
      }
      results.onedrive = {
        currentRootFolderId: env.ONEDRIVE_ROOT_FOLDER_ID || "(not set)",
        driveRootFolders: rootFolders,
        productionSubfolders: prodChildren,
      };
    } catch (e) { results.onedrive = { error: e.message }; }
    // Figma: check template file
    try {
      const figToken = env.FIGMA_TOKEN || env.FIGMA_ACCESS_TOKEN;
      const fileKey = env.FIGMA_TEMPLATE_FILE_KEY;
      const figRes = await tfetch(`https://api.figma.com/v1/files/${fileKey}?depth=1`, {
        headers: { "X-Figma-Token": figToken },
      });
      const figData = await figRes.json();
      results.figma = { currentFileKey: fileKey, status: figRes.ok ? "found" : "not_found", name: figData.name || figData.err };
    } catch (e) { results.figma = { error: e.message }; }
    // Notion: search databases
    try {
      const nToken = env.NOTION_TOKEN;
      const dbId = env.NOTION_PROJECTS_DB_ID;
      const searchRes = await tfetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${nToken}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
        body: JSON.stringify({ filter: { property: "object", value: "database" }, page_size: 10 }),
      });
      const searchData = await searchRes.json();
      results.notion = {
        currentDbId: dbId || "(not set)",
        availableDbs: (searchData.results || []).map(d => ({ id: d.id, title: d.title?.[0]?.plain_text || "untitled" })),
      };
    } catch (e) { results.notion = { error: e.message }; }
    return Response.json(results);
  }

  // Dropbox path debug: ?check=dropbox-path
  if (url.searchParams.get("check") === "dropbox-path") {
    try {
      const { getDropboxToken } = await import("../../lib/provisioner/services/dropbox-auth.js");
      const token = await getDropboxToken(env);
      const templatePath = env.DROPBOX_TEMPLATE_PATH || "(not set)";
      const rootRes = await tfetch("https://api.dropboxapi.com/2/files/list_folder", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: "", limit: 20 }),
      });
      const rootData = await rootRes.json();
      const rootFolders = rootData.entries?.map(e => e.path_display) || [];
      const metaRes = await tfetch("https://api.dropboxapi.com/2/files/get_metadata", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: templatePath }),
      });
      const metaData = await metaRes.json();
      return Response.json({ templatePath, rootFolders, templateMeta: metaData });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Quick config check: ?check=config
  if (url.searchParams.get("check") === "config") {
    const configVars = {
      // Dropbox
      DROPBOX_TEMPLATE_PATH: !!env.DROPBOX_TEMPLATE_PATH,
      DROPBOX_APP_KEY: !!env.DROPBOX_APP_KEY,
      DROPBOX_APP_SECRET: !!env.DROPBOX_APP_SECRET,
      DROPBOX_REFRESH_TOKEN: !!env.DROPBOX_REFRESH_TOKEN,
      // Frame.io
      FRAMEIO_TOKEN: !!env.FRAMEIO_TOKEN,
      FRAMEIO_TEAM_ID: !!env.FRAMEIO_TEAM_ID,
      // Canva
      CANVA_ROOT_FOLDER_ID: !!env.CANVA_ROOT_FOLDER_ID,
      // OneDrive
      ONEDRIVE_DRIVE_ID: !!env.ONEDRIVE_DRIVE_ID,
      ONEDRIVE_ROOT_FOLDER_ID: !!env.ONEDRIVE_ROOT_FOLDER_ID,
      // Clockify
      CLOCKIFY_API_KEY: !!env.CLOCKIFY_API_KEY,
      CLOCKIFY_WORKSPACE_ID: !!env.CLOCKIFY_WORKSPACE_ID,
      // Figma
      FIGMA_TOKEN: !!(env.FIGMA_TOKEN || env.FIGMA_ACCESS_TOKEN),
      FIGMA_TEMPLATE_FILE_KEY: !!env.FIGMA_TEMPLATE_FILE_KEY,
      // Notion
      NOTION_TOKEN: !!env.NOTION_TOKEN,
      NOTION_PROJECTS_DB_ID: !!env.NOTION_PROJECTS_DB_ID,
      // Graph (OneDrive + Teams Chat)
      AZURE_TENANT_ID: !!(env.AZURE_TENANT_ID || env.GRAPH_TENANT_ID),
      AZURE_CLIENT_ID: !!(env.AZURE_CLIENT_ID || env.GRAPH_CLIENT_ID),
      AZURE_CLIENT_SECRET: !!(env.AZURE_CLIENT_SECRET || env.GRAPH_CLIENT_SECRET),
    };
    const missing = Object.entries(configVars).filter(([, v]) => !v).map(([k]) => k);
    return Response.json({ configVars, missing, allSet: missing.length === 0 });
  }

  // All available tests
  const allTests = {
    dropbox: () => testDropbox(env),
    frameio: () => testFrameIo(env),
    canva: () => testCanva(env),
    onedrive: () => testOneDrive(env),
    clockify: () => testClockify(env),
    figma: () => testFigma(env),
    notion: () => testNotion(env),
    boords: () => testBoords(env),
    elevenlabs: () => testElevenLabs(env),
    anthropic: () => testAnthropic(env),
    teams_bot: () => testTeamsBot(env),
  };

  // Optional: test a single service via ?service=name
  const serviceParam = url.searchParams.get("service");
  const testsToRun = serviceParam
    ? { [serviceParam]: allTests[serviceParam] }
    : allTests;

  if (serviceParam && !allTests[serviceParam]) {
    return Response.json({
      error: `Unknown service: ${serviceParam}`,
      available: Object.keys(allTests),
    }, { status: 400 });
  }

  const results = {};
  const testNames = Object.keys(testsToRun);
  const testPromises = testNames.map(name => testsToRun[name]());

  const settled = await Promise.allSettled(testPromises);

  for (let i = 0; i < settled.length; i++) {
    const name = testNames[i];
    if (settled[i].status === "fulfilled") {
      results[name] = settled[i].value;
    } else {
      const err = settled[i].reason;
      results[name] = {
        status: err?.name === "AbortError" ? "timeout" : "error",
        message: err?.name === "AbortError"
          ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : (err?.message || String(err)),
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
    const tokenRes = await tfetch("https://api.dropboxapi.com/oauth2/token", {
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

  const res = await tfetch("https://api.dropboxapi.com/2/users/get_current_account", {
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
  const res = await tfetch("https://api.frame.io/v2/me", {
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
              const refreshRes = await tfetch("https://api.canva.com/rest/v1/oauth/token", {
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

  const res = await tfetch("https://api.canva.com/rest/v1/users/me", {
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

  const tokenRes = await tfetch(tokenUrl, {
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
  const graphRes = await tfetch(graphUrl, {
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
  const res = await tfetch("https://api.clockify.me/api/v1/user", {
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
  const res = await tfetch("https://api.figma.com/v1/me", {
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
    const fileRes = await tfetch(`https://api.figma.com/v1/files/${templateKey}?depth=1`, {
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
  const res = await tfetch("https://api.notion.com/v1/users/me", {
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
  const res = await tfetch("https://app.boords.com/api/projects", {
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
  const res = await tfetch("https://api.elevenlabs.io/v1/user", {
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
  const res = await tfetch("https://api.anthropic.com/v1/messages", {
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

  const res = await tfetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
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

/**
 * Temporary file serving endpoint.
 * GET /api/temp-file/:key — serves a modified PPTX.
 *
 * Three strategies:
 *
 * 1. Inline-modify (< 25MB): Modified PPTX bytes stored in KV under
 *    `temp_pptx_{key}`. Just streams the bytes back.
 *
 * 2. Proxy-modify via URL params (>= 25MB): Config encoded as base64
 *    in the `c` query param. Downloads + modifies on-the-fly.
 *    No KV involved — avoids eventual consistency issues.
 *    Route: /api/temp-file/proxy?c=BASE64_CONFIG
 *
 * 3. Legacy proxy-modify via KV config (kept for backwards compat):
 *    JSON config stored in KV under `temp_pptx_config_{key}`.
 *
 * KV Eventual Consistency:
 *   For inline-modify, the endpoint retries KV reads with delays.
 *   For proxy-modify via URL params, no KV is needed.
 *
 * IMPORTANT: Returns 410 (Gone) instead of 404 for missing keys.
 * Cloudflare Pages SPA fallback converts 404 -> 200.
 */

import { modifyPptxText } from "../../../lib/deck/pptx-text-replace.js";

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function pptxHeaders(filename) {
  return {
    "Content-Type": PPTX_CONTENT_TYPE,
    "Content-Disposition": `attachment; filename="${filename}.pptx"`,
    "Cache-Control": "no-store",
  };
}

export async function onRequestGet(context) {
  const key = context.params.key;
  if (!key) return new Response("Missing key", { status: 400 });

  const { env } = context;
  const url = new URL(context.request.url);

  // ── Strategy 2: Proxy-modify via URL params (no KV needed) ──
  // Route: /api/temp-file/proxy?c=BASE64_CONFIG
  if (key === "proxy") {
    const configB64 = url.searchParams.get("c");
    if (!configB64) return new Response("Missing config param", { status: 400 });

    try {
      // Decode base64 → UTF-8 JSON
      const bytes = Uint8Array.from(atob(configB64), (c) => c.charCodeAt(0));
      const configJson = new TextDecoder().decode(bytes);
      const config = JSON.parse(configJson);
      const { downloadUrl, modParams } = config;

      // Download the PPTX from Canva's CDN
      const pptxRes = await fetch(downloadUrl);
      if (!pptxRes.ok) {
        return new Response(`PPTX download failed: ${pptxRes.status}`, { status: 502 });
      }
      const pptxBuffer = await pptxRes.arrayBuffer();

      // Modify text in memory
      const modified = modifyPptxText(pptxBuffer, modParams);

      return new Response(modified, { headers: pptxHeaders("deck") });
    } catch (err) {
      return new Response(`Proxy-modify failed: ${err.message}`, { status: 500 });
    }
  }

  // ── Strategy 1: Inline-modify (binary bytes in KV) ──
  // Retry KV reads to handle eventual consistency.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAY_MS);

    const data = await env.RF_STORE.get(`temp_pptx_${key}`, "arrayBuffer");
    if (data) {
      env.RF_STORE.delete(`temp_pptx_${key}`).catch(() => {});
      return new Response(data, { headers: pptxHeaders(key) });
    }

    // Legacy: proxy-modify config in KV
    const configRaw = await env.RF_STORE.get(`temp_pptx_config_${key}`);
    if (configRaw) {
      try {
        const config = JSON.parse(configRaw);
        const { downloadUrl, modParams } = config;
        const pptxRes = await fetch(downloadUrl);
        if (!pptxRes.ok) {
          return new Response(`PPTX download failed: ${pptxRes.status}`, { status: 502 });
        }
        const pptxBuffer = await pptxRes.arrayBuffer();
        const modified = modifyPptxText(pptxBuffer, modParams);
        env.RF_STORE.delete(`temp_pptx_config_${key}`).catch(() => {});
        return new Response(modified, { headers: pptxHeaders(key) });
      } catch (err) {
        return new Response(`Proxy-modify failed: ${err.message}`, { status: 500 });
      }
    }
  }

  // All retries exhausted
  return new Response("Not found or expired", { status: 410 });
}

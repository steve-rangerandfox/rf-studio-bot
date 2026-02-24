/**
 * Shared deck generation pipeline — two-phase architecture.
 *
 * Cloudflare Pages Functions (free plan) have a HARD 30-second wall-clock
 * timeout per request. The full pipeline (export + modify + import + poll)
 * takes 30-90 seconds, so we split it into two independent requests:
 *
 * Phase 1 — startDeckGeneration()  (~15-22 seconds)
 *   1. Map selected page IDs -> 1-based page indices
 *   2. Export those specific pages as PPTX
 *   3. Download, modify text (Selected Work + cover date)
 *   4. Start import (but DON'T poll for completion)
 *   Returns { importJobId, deckName, pageCount, ... }
 *
 * Phase 2 — completeDeckImport()  (~10-22 seconds)
 *   5. Poll for import completion
 *   6. Save to history in KV
 *   Returns { designId, editUrl, viewUrl, pageCount }
 *
 * The original generateDeck() is kept as a convenience wrapper for the
 * web UI / curl path where the 30-second limit isn't an issue.
 */

import { getValidToken } from "./canva-token.js";
import { modifyPptxText } from "./pptx-text-replace.js";

const KV_MAX_VALUE_SIZE = 25 * 1024 * 1024; // 25MB KV limit
const WORKER_MODIFY_MAX = 50 * 1024 * 1024; // 50MB — surgical ZIP needs ~2x memory

/**
 * Phase 1: Export from Canva, modify PPTX, start import.
 * Designed to complete within ~20 seconds.
 */
export async function startDeckGeneration(env, params) {
  const {
    deckName, selectedIds, clientName, author,
    coverMonth, coverDay, coverYear,
    selectedWork, siteBaseUrl,
  } = params;

  const raw = await env.RF_STORE.get("config");
  if (!raw) throw new Error("Not configured");
  const config = JSON.parse(raw);
  const apiToken = await getValidToken(env);
  const masterDesignId = config.masterDesignId;

  if (!apiToken || !masterDesignId) {
    throw new Error("Missing API token or design ID");
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  // ── Step 1: Read page_map + text maps in parallel ──
  const [pageMapRaw, swMapRaw, coverMapRaw] = await Promise.all([
    env.RF_STORE.get("page_map"),
    env.RF_STORE.get("sw_text_map"),
    env.RF_STORE.get("cover_text_map"),
  ]);

  if (!pageMapRaw) throw new Error("Page map not found in KV");
  const pageMap = JSON.parse(pageMapRaw);

  const selectedIndices = [];
  for (const id of selectedIds) {
    const entry = pageMap.find((pm) => pm.id === id);
    if (entry) selectedIndices.push(entry.index);
  }
  selectedIndices.sort((a, b) => a - b);

  if (selectedIndices.length === 0) {
    throw new Error("No valid page indices found for the selected pages");
  }

  // ── Step 2: Export selected pages as PPTX ──
  const exportRes = await fetch("https://api.canva.com/rest/v1/exports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      design_id: masterDesignId,
      format: { type: "pptx", pages: selectedIndices },
    }),
  });

  if (!exportRes.ok) {
    const text = await exportRes.text();
    throw new Error(`Export POST failed (${exportRes.status}): ${text}`);
  }

  const exportJob = await exportRes.json();
  const exportJobId = exportJob.job?.id;
  if (!exportJobId) throw new Error("Export job did not return an ID");

  // Poll for export completion (1.5s intervals for speed — under 30s budget)
  let exportResult = null;
  for (let i = 0; i < 16; i++) {
    await delay(1500);
    const pollRes = await fetch(`https://api.canva.com/rest/v1/exports/${exportJobId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    const jobStatus = pollData.job?.status;
    if (jobStatus === "success") {
      const urls = pollData.job.urls || [];
      if (urls.length > 0) exportResult = { url: urls[0] };
      break;
    }
    if (jobStatus === "failed") {
      throw new Error(`Export job failed: ${pollData.job.error?.message || "unknown error"}`);
    }
  }

  if (!exportResult) throw new Error("Export timed out");
  const downloadUrl = exportResult.url;
  if (!downloadUrl) throw new Error("Export succeeded but returned no download URL");

  await debugLog(env, "[phase1] Export done:", downloadUrl.slice(0, 60));

  // ── Step 3: Download, modify, and store the PPTX ──
  let importUrl = downloadUrl;
  let tempKey = null;
  let tempPrefix = null;
  const hasPptxModData = swMapRaw && selectedWork;

  if (hasPptxModData) {
    try {
      const masterWork = JSON.parse(swMapRaw);
      const masterCover = coverMapRaw ? JSON.parse(coverMapRaw) : null;
      const cover = (coverMonth || coverDay || coverYear)
        ? { month: coverMonth, day: coverDay, year: coverYear }
        : null;

      const modParams = { selectedWork, masterWork, cover, masterCover };
      tempKey = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const baseUrl = siteBaseUrl || config.siteBaseUrl || "https://rf-deck-builder.pages.dev";

      const headRes = await fetch(downloadUrl, { method: "HEAD" });
      const contentLength = parseInt(headRes.headers.get("content-length") || "0", 10);

      if (contentLength > WORKER_MODIFY_MAX) {
        importUrl = downloadUrl;
        tempKey = null;
        tempPrefix = null;
        await debugLog(env, "[phase1] PPTX too large:", contentLength, "bytes — importing original");
      } else if (contentLength > 0 && contentLength < KV_MAX_VALUE_SIZE) {
        // Inline-modify: download, modify, store in KV
        const pptxRes = await fetch(downloadUrl);
        if (!pptxRes.ok) throw new Error(`PPTX download failed: ${pptxRes.status}`);
        const pptxBuffer = await pptxRes.arrayBuffer();
        const modified = modifyPptxText(pptxBuffer, modParams);

        await env.RF_STORE.put(`temp_pptx_${tempKey}`, modified, { expirationTtl: 300 });
        tempPrefix = "temp_pptx_";
        importUrl = `${baseUrl}/api/temp-file/${tempKey}`;
        await debugLog(env, "[phase1] Inline-modify OK:", modified.length, "bytes, key:", tempKey);
        await delay(1500); // Brief KV propagation wait (reduced from 3s)
      } else {
        // Proxy-modify: store config, temp-file endpoint does download+modify
        await env.RF_STORE.put(`temp_pptx_config_${tempKey}`, JSON.stringify({
          downloadUrl, modParams,
        }), { expirationTtl: 300 });
        tempPrefix = "temp_pptx_config_";
        importUrl = `${baseUrl}/api/temp-file/${tempKey}`;
        await debugLog(env, "[phase1] Proxy-modify config stored:", contentLength, "bytes");
        await delay(5000); // KV propagation wait (reduced from 10s)
      }
    } catch (modErr) {
      importUrl = downloadUrl;
      tempKey = null;
      tempPrefix = null;
      await debugLog(env, "[phase1] PPTX mod FAILED:", modErr.message);
    }
  }

  // ── Step 4: Start the import (but DON'T poll yet) ──
  const importRes = await fetch("https://api.canva.com/rest/v1/url-imports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: importUrl,
      title: deckName || "R&F Capabilities Deck",
      mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  });

  if (!importRes.ok) {
    const text = await importRes.text();
    throw new Error(`Import POST failed (${importRes.status}): ${text}`);
  }

  const importJob = await importRes.json();
  const importJobId = importJob.job?.id;
  if (!importJobId) throw new Error("Import job did not return an ID");

  await debugLog(env, "[phase1] Import started, jobId:", importJobId);

  return {
    importJobId,
    importUrl,
    downloadUrl,
    deckName: deckName || "R&F Capabilities Deck",
    clientName: clientName || "",
    author: author || "",
    pageCount: selectedIndices.length,
    tempKey,
    tempPrefix,
  };
}

/**
 * Phase 2: Poll for import completion and finalize.
 * Designed to complete within ~20 seconds.
 */
export async function completeDeckImport(env, phase1Result) {
  const {
    importJobId, importUrl, downloadUrl,
    deckName, clientName, author, pageCount,
    tempKey, tempPrefix,
  } = phase1Result;

  const apiToken = await getValidToken(env);
  const authHeader = { Authorization: `Bearer ${apiToken}` };

  await debugLog(env, "[phase2] Polling import jobId:", importJobId);

  // Poll for import completion (1.5s intervals, up to 25s)
  let importResult = null;
  let importFailed = false;
  let importError = "";

  for (let i = 0; i < 17; i++) {
    await delay(1500);
    const pollRes = await fetch(`https://api.canva.com/rest/v1/url-imports/${importJobId}`, {
      headers: authHeader,
    });
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    const jobStatus = pollData.job?.status;
    if (jobStatus === "success") {
      importResult = pollData.job.result;
      break;
    }
    if (jobStatus === "failed") {
      importFailed = true;
      importError = pollData.job.error?.message || "unknown error";
      break;
    }
  }

  // If import failed with modified URL, retry once with direct URL
  if (importFailed && tempKey && importUrl !== downloadUrl) {
    await debugLog(env, "[phase2] Import failed with proxy URL, retrying with direct URL");
    const retryRes = await fetch("https://api.canva.com/rest/v1/url-imports", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: downloadUrl,
        title: deckName,
        mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    });

    if (retryRes.ok) {
      const retryJob = await retryRes.json();
      const retryJobId = retryJob.job?.id;
      if (retryJobId) {
        importFailed = false;
        importError = "";
        for (let i = 0; i < 12; i++) {
          await delay(1500);
          const pollRes = await fetch(`https://api.canva.com/rest/v1/url-imports/${retryJobId}`, {
            headers: authHeader,
          });
          if (!pollRes.ok) continue;
          const pollData = await pollRes.json();
          if (pollData.job?.status === "success") {
            importResult = pollData.job.result;
            break;
          }
          if (pollData.job?.status === "failed") {
            importFailed = true;
            importError = pollData.job.error?.message || "unknown";
            break;
          }
        }
      }
    }
  }

  if (importFailed) throw new Error(`Import failed: ${importError}`);
  if (!importResult) throw new Error("Import timed out");

  // Clean up temp file
  if (tempKey && tempPrefix) {
    env.RF_STORE.delete(`${tempPrefix}${tempKey}`).catch(() => {});
  }

  // Get new design info
  const designs = importResult.designs || [];
  if (designs.length === 0) throw new Error("Import completed but returned no designs");

  const newDesign = designs[0];
  const newDesignId = newDesign.id;
  const editUrl = newDesign.urls?.edit_url || `https://www.canva.com/design/${newDesignId}/edit`;
  const viewUrl = newDesign.urls?.view_url || editUrl;

  // Save to history
  const historyRaw = await env.RF_STORE.get("history");
  const history = historyRaw ? JSON.parse(historyRaw) : [];
  history.unshift({
    designId: newDesignId, editUrl, viewUrl, deckName,
    clientName, author, pageCount,
    createdAt: new Date().toISOString(),
  });
  if (history.length > 100) history.length = 100;

  await Promise.all([
    env.RF_STORE.put("history", JSON.stringify(history)),
    debugLog(env, "[phase2] SUCCESS designId:", newDesignId, "pages:", pageCount),
  ]);

  return { designId: newDesignId, editUrl, viewUrl, pageCount };
}

/**
 * Full pipeline (for web UI / curl — no 30s limit).
 * Calls both phases sequentially in a single request.
 */
export async function generateDeck(env, params) {
  const phase1 = await startDeckGeneration(env, params);
  return completeDeckImport(env, phase1);
}

// ── Utilities ──

async function debugLog(env, ...args) {
  try {
    const raw = await env.RF_STORE.get("bot_debug_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ t: new Date().toISOString(), msg: args.map(String).join(" ") });
    while (logs.length > 100) logs.shift();
    await env.RF_STORE.put("bot_debug_logs", JSON.stringify(logs), { expirationTtl: 3600 });
  } catch (_) {}
}

function delay(ms) {
  if (typeof scheduler !== "undefined" && scheduler.wait) {
    return scheduler.wait(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

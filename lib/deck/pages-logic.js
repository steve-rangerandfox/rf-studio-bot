/**
 * Shared page-fetching and caching logic.
 * Used by both the /api/pages endpoint and the Teams bot.
 */

import { getValidToken } from "./canva-token.js";

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch pages from Canva API with KV caching.
 * @param {object} env — Cloudflare env with RF_STORE binding
 * @param {boolean} forceRefresh — bypass cache
 * @returns {{ pages: Array, fetchedAt: string, fromCache: boolean, stale?: boolean }}
 */
export async function fetchAndCachePages(env, forceRefresh = false) {
  const raw = await env.RF_STORE.get("config");
  if (!raw) throw new Error("Not configured");
  const config = JSON.parse(raw);
  const apiToken = await getValidToken(env);

  if (!apiToken || !config.masterDesignId) {
    throw new Error("Missing API token or design ID");
  }

  // Check cache unless force refresh
  if (!forceRefresh) {
    const cached = await env.RF_STORE.get("pages_cache");
    if (cached) {
      const data = JSON.parse(cached);
      const age = Date.now() - new Date(data.fetchedAt).getTime();
      if (age < CACHE_TTL) {
        return { pages: data.pages, fetchedAt: data.fetchedAt, fromCache: true };
      }
      // Stale — return it but flag it
      return { pages: data.pages, fetchedAt: data.fetchedAt, fromCache: true, stale: true };
    }
  }

  // Fetch from Canva API (gives us index + thumbnails, but NOT page names or IDs)
  const res = await fetch(
    `https://api.canva.com/rest/v1/designs/${config.masterDesignId}/pages`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canva API ${res.status}: ${text}`);
  }

  const json = await res.json();
  const apiPages = json.items || [];

  // Get the static page map from KV (provides page IDs and titles that the API lacks)
  const pageMapRaw = await env.RF_STORE.get("page_map");
  const pageMap = pageMapRaw ? JSON.parse(pageMapRaw) : [];

  // Merge: API gives thumbnails by index, page map gives Canva page IDs and titles
  const pages = apiPages.map((ap) => {
    const mapped = pageMap.find((pm) => pm.index === ap.index);
    return {
      id: mapped ? mapped.id : `page_${ap.index}`,
      title: mapped ? mapped.title : "",
      thumbnail: ap.thumbnail?.url || null,
    };
  });

  const fetchedAt = new Date().toISOString();
  await env.RF_STORE.put("pages_cache", JSON.stringify({ pages, fetchedAt }));

  return { pages, fetchedAt, fromCache: false };
}

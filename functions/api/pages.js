import { fetchAndCachePages } from "../../lib/deck/pages-logic.js";

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.has("refresh");

  try {
    const result = await fetchAndCachePages(env, forceRefresh);
    return Response.json(result);
  } catch (err) {
    const status = err.message.includes("Not configured") ? 400
      : err.message.includes("Missing API") ? 400
      : err.message.includes("Canva API") ? 502
      : 500;
    return Response.json({ error: err.message }, { status });
  }
}

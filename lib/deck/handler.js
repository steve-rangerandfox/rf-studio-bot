/**
 * Deck Builder feature handler for the unified RF Studio Bot.
 *
 * Exports two entry points consumed by the main bot router:
 *   handleDeckText(context, activity)  — text commands: "new deck", "cancel", "help"
 *   handleDeckCard(context, activity)  — card submissions: selectPages, coverInfo,
 *                                        backToSelect, backToCover, generate, newDeck
 *
 * All state operations include `feature: 'deck'` so the router can dispatch
 * future messages back to this handler.
 */

import { getState, setState, clearState } from "../shared/state.js";
import { sendCard, sendText } from "../shared/send.js";
import {
  buildPageSelectionCard,
  buildCoverInfoCard,
  buildReviewCard,
} from "./cards.js";
import { startDeckGeneration } from "./logic.js";
import { fetchAndCachePages } from "./pages-logic.js";
import { groupPages, computeSelectedWork } from "./page-parser.js";

// ── Debug logger (KV-based, matches original bot.js pattern) ──

async function debugLog(env, ...args) {
  try {
    const raw = await env.RF_STORE.get("bot_debug_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ t: new Date().toISOString(), msg: args.map(String).join(" ") });
    while (logs.length > 100) logs.shift();
    await env.RF_STORE.put("bot_debug_logs", JSON.stringify(logs), { expirationTtl: 3600 });
  } catch (_) {}
}

// ── Text message handler ──

/**
 * Handle deck-specific text commands.
 * @param {object} context — Cloudflare Pages Function context (has env, waitUntil, request)
 * @param {object} activity — Bot Framework activity
 */
export async function handleDeckText(context, activity) {
  const { env } = context;
  const convId = activity.conversation?.id;
  const serviceUrl = normalizeServiceUrl(activity.serviceUrl);
  const raw = (activity.text || "").replace(/<at>[^<]*<\/at>/gi, "").trim().toLowerCase();

  if (raw.includes("new deck") || raw.includes("build deck") || raw.includes("start")) {
    await startNewDeck(env, convId, serviceUrl);
  } else if (raw.includes("cancel") || raw.includes("stop")) {
    await clearState(env, convId);
    await sendText(env, serviceUrl, convId, "Deck building cancelled. Say **new deck** to start again.");
  } else if (raw.includes("help")) {
    await sendText(
      env,
      serviceUrl,
      convId,
      "**RF Deck Builder Bot** \u{1F3D7}\uFE0F\n\n" +
        "Commands:\n" +
        "- **new deck** \u2014 Start building a new capabilities deck\n" +
        "- **cancel** \u2014 Cancel the current deck build\n" +
        "- **help** \u2014 Show this message"
    );
  } else {
    const state = await getState(env, convId);
    if (state && state.feature === "deck") {
      await sendText(
        env,
        serviceUrl,
        convId,
        "You're in the middle of building a deck. Use the card above to continue, or say **cancel** to start over."
      );
    } else {
      await sendText(
        env,
        serviceUrl,
        convId,
        "Hey! Say **new deck** to start building a capabilities deck, or **help** for more info."
      );
    }
  }
}

// ── Card submit handler ──

/**
 * Handle deck-specific card submissions.
 * @param {object} context — Cloudflare Pages Function context (has env, waitUntil, request)
 * @param {object} activity — Bot Framework activity
 */
export async function handleDeckCard(context, activity) {
  const { env, request } = context;
  const convId = activity.conversation?.id;
  const serviceUrl = normalizeServiceUrl(activity.serviceUrl);

  // Extract card data — handle both message and invoke types
  const cardValue = activity.value;
  const data = cardValue?.data || cardValue;
  const action = data?.action || cardValue?.action;

  // Two-phase generation: send "Generating..." immediately, return 200 to
  // Teams, then run Phase 1 in waitUntil and fire Phase 2 as separate request.
  if (action === "generate") {
    await debugLog(env, "Deck generate action — two-phase with waitUntil");
    await sendText(env, serviceUrl, convId,
      "\u23F3 Generating your deck... This takes 30\u201360 seconds.\n\nYour deck link will appear here when ready! \u{1F680}"
    );
    const state = await getState(env, convId);
    context.waitUntil(
      handleGenerate(env, convId, serviceUrl, state, data, request.url)
        .catch(async (err) => {
          await debugLog(env, "Deck generate UNHANDLED:", err.message, err.stack);
        })
    );
    return;
  }

  const state = await getState(env, convId);

  switch (action) {
    case "selectPages":
      await handlePageSelection(env, convId, serviceUrl, state, data);
      break;
    case "coverInfo":
      await handleCoverInfo(env, convId, serviceUrl, state, data);
      break;
    case "backToSelect":
      await handleBackToSelect(env, convId, serviceUrl, state, data);
      break;
    case "backToCover":
      await handleBackToCover(env, convId, serviceUrl, state, data);
      break;
    case "newDeck":
      await startNewDeck(env, convId, serviceUrl);
      break;
    default:
      await sendText(env, serviceUrl, convId, "Unknown action. Say **new deck** to start over.");
  }
}

// ── Flow handlers ──

async function startNewDeck(env, convId, serviceUrl) {
  await debugLog(env, "startNewDeck called — convId:", convId?.slice(0, 30));
  // Check config exists
  const configRaw = await env.RF_STORE.get("config");
  await debugLog(env, "Config exists:", !!configRaw);
  if (!configRaw) {
    await debugLog(env, "No config — attempting to send 'not configured' message");
    try {
      const res = await sendText(
        env,
        serviceUrl,
        convId,
        "The Deck Builder isn't configured yet. Please set it up at the admin page first."
      );
      await debugLog(env, "sendText response:", res.status, res.ok);
    } catch (sendErr) {
      await debugLog(env, "sendText THREW:", sendErr.message);
    }
    return;
  }

  // Fetch pages
  let pagesData;
  try {
    pagesData = await fetchAndCachePages(env);
  } catch (err) {
    await sendText(env, serviceUrl, convId, `Failed to fetch pages: ${err.message}`);
    return;
  }

  const { locked, intros, projectGroups } = groupPages(pagesData.pages);

  if (projectGroups.length === 0) {
    await sendText(
      env,
      serviceUrl,
      convId,
      "No project pages found in the master deck. Make sure pages follow the naming convention: `project: CLIENT | Project Name #`"
    );
    return;
  }

  // Save initial state (includes feature: 'deck' for routing)
  await setState(env, convId, {
    feature: "deck",
    step: "select",
    locked,
    intros,
    projectGroups,
    selectedIntroIds: [],
    selectedProjectKeys: [],
    selectedIds: locked.map((p) => p.id),
    author: "",
    deckName: "",
    clientName: "",
    coverDate: "",
    serviceUrl,
    conversationId: convId,
  });

  // Send page selection card
  const card = buildPageSelectionCard(locked, intros, projectGroups);
  await sendCard(env, serviceUrl, convId, card);
}

async function handlePageSelection(env, convId, serviceUrl, state, data) {
  if (!state) {
    await sendText(env, serviceUrl, convId, "Session expired. Say **new deck** to start again.");
    return;
  }

  // Parse comma-separated selections from Adaptive Card
  const selectedIntroIds = data.selectedIntros ? data.selectedIntros.split(",").filter(Boolean) : [];
  const selectedProjectKeys = data.selectedProjects ? data.selectedProjects.split(",").filter(Boolean) : [];

  if (selectedProjectKeys.length === 0) {
    await sendText(env, serviceUrl, convId, "Please select at least one project to continue.");
    // Re-send the card
    const card = buildPageSelectionCard(state.locked, state.intros, state.projectGroups);
    await sendCard(env, serviceUrl, convId, card);
    return;
  }

  // Compute full selectedIds
  const lockedIds = state.locked.map((p) => p.id);
  const introIds = state.intros.filter((p) => selectedIntroIds.includes(p.id)).map((p) => p.id);
  const projectIds = state.projectGroups
    .filter((g) => selectedProjectKeys.includes(g.groupKey))
    .flatMap((g) => g.pages.map((p) => p.id));

  const selectedIds = [...lockedIds, ...introIds, ...projectIds];

  // Get team name for cover card
  const configRaw = await env.RF_STORE.get("config");
  const config = configRaw ? JSON.parse(configRaw) : {};

  await setState(env, convId, {
    ...state,
    feature: "deck",
    step: "cover",
    selectedIntroIds,
    selectedProjectKeys,
    selectedIds,
    serviceUrl,
  });

  // Pass selections through the card data (survives KV eventual-consistency)
  const selections = {
    selectedIntroIds: selectedIntroIds.join(","),
    selectedProjectKeys: selectedProjectKeys.join(","),
    selectedIds: selectedIds.join(","),
  };
  const card = buildCoverInfoCard(config.teamName, null, selections);
  await sendCard(env, serviceUrl, convId, card);
}

async function handleCoverInfo(env, convId, serviceUrl, state, data) {
  await debugLog(env, "handleCoverInfo START, state:", state ? "exists" : "null", "data keys:", Object.keys(data || {}).join(","));

  if (!state) {
    await sendText(env, serviceUrl, convId, "Session expired. Say **new deck** to start again.");
    return;
  }

  const configRaw = await env.RF_STORE.get("config");
  const config = configRaw ? JSON.parse(configRaw) : {};

  const author = data.author || "";
  const deckName = data.deckName || "";
  const clientName = data.clientName || "";
  const coverDate = data.coverDate || "";

  // Prefer selections from card data (survives KV eventual-consistency across CF edges)
  const selectedProjectKeys = data._selectedProjectKeys
    ? data._selectedProjectKeys.split(",").filter(Boolean)
    : (state.selectedProjectKeys || []);
  const selectedIntroIds = data._selectedIntroIds
    ? data._selectedIntroIds.split(",").filter(Boolean)
    : (state.selectedIntroIds || []);
  const selectedIds = data._selectedIds
    ? data._selectedIds.split(",").filter(Boolean)
    : (state.selectedIds || []);

  await debugLog(env, "coverInfo values:", JSON.stringify({ author, deckName, clientName, coverDate }));
  await debugLog(env, "coverInfo selections (from card data):",
    "projectKeys:", selectedProjectKeys.length,
    "introIds:", selectedIntroIds.length,
    "pageIds:", selectedIds.length);

  // Update state with merged selections + cover info
  await setState(env, convId, {
    ...state,
    feature: "deck",
    step: "review",
    selectedProjectKeys,
    selectedIntroIds,
    selectedIds,
    author,
    deckName,
    clientName,
    coverDate,
    serviceUrl,
  });

  const selProj = state.projectGroups.filter((g) => selectedProjectKeys.includes(g.groupKey));
  await debugLog(env, "coverInfo selProj:", selProj.length, "selectedProjectKeys:", JSON.stringify(selectedProjectKeys));

  const summary = {
    deckName: deckName || `${config.teamName || "R&F"} \u2014 ${clientName || "Capabilities"}`,
    clientName,
    coverDate,
    author,
    pageCount: selectedIds.length,
    projectCount: selProj.length,
    projects: selProj.map((g) => ({ client: g.client, project: g.projectName })),
  };

  // Pass all state through the review card actions (avoids KV propagation issues)
  const stateCarry = {
    selectedIntroIds: selectedIntroIds.join(","),
    selectedProjectKeys: selectedProjectKeys.join(","),
    selectedIds: selectedIds.join(","),
    author,
    deckName,
    clientName,
    coverDate,
  };

  await debugLog(env, "coverInfo sending review card");
  const card = buildReviewCard(summary, stateCarry);
  await sendCard(env, serviceUrl, convId, card);
  await debugLog(env, "handleCoverInfo DONE");
}

/**
 * Two-phase generation handler.
 * Runs inside context.waitUntil() — "Generating..." message already sent.
 *
 * Phase 1 (~15-22s): Export from Canva, modify PPTX, start import
 * Phase 2 (~10-22s): Fires as a separate worker request to /api/generate-bot
 */
async function handleGenerate(env, convId, serviceUrl, state, data, requestUrl) {
  if (!state) {
    await sendText(env, serviceUrl, convId, "Session expired. Say **new deck** to start again.");
    return;
  }

  const configRaw = await env.RF_STORE.get("config");
  const config = configRaw ? JSON.parse(configRaw) : {};

  // Prefer data from card submit (survives KV eventual-consistency across CF edges)
  const d = data || {};
  const selectedIds = d._selectedIds
    ? d._selectedIds.split(",").filter(Boolean)
    : (state.selectedIds || []);
  const selectedProjectKeys = d._selectedProjectKeys
    ? d._selectedProjectKeys.split(",").filter(Boolean)
    : (state.selectedProjectKeys || []);
  const author = d._author || state.author || "";
  const deckNameRaw = d._deckName || state.deckName || "";
  const clientName = d._clientName || state.clientName || "";
  const coverDate = d._coverDate || state.coverDate || "";

  await debugLog(env, "handleGenerate — selectedIds:", selectedIds.length,
    "projectKeys:", selectedProjectKeys.length,
    "client:", clientName, "author:", author);

  // Parse cover date
  let mm = "", dd2 = "", yy = "";
  if (coverDate) {
    const pd = new Date(coverDate + "T12:00:00");
    mm = String(pd.getMonth() + 1).padStart(2, "0");
    dd2 = String(pd.getDate()).padStart(2, "0");
    yy = String(pd.getFullYear());
  }

  // Compute Selected Work slots (bottom-up)
  const selProj = state.projectGroups.filter((g) => selectedProjectKeys.includes(g.groupKey));
  const selectedWork = computeSelectedWork(selProj);
  const finalName = deckNameRaw || `${config.teamName || "R&F"} \u2014 ${clientName || "Capabilities"}`;

  try {
    // ── Phase 1: Export + modify + start import (~15-22s) ──
    const phase1Result = await startDeckGeneration(env, {
      deckName: finalName,
      selectedIds,
      clientName,
      coverMonth: mm,
      coverDay: dd2,
      coverYear: yy,
      author,
      selectedWork,
      siteBaseUrl: new URL(requestUrl).origin,
    });

    await debugLog(env, "[phase1] Done — importJobId:", phase1Result.importJobId, "— firing Phase 2");

    // ── Fire Phase 2 as a separate worker request (own 30s budget) ──
    const botUrl = new URL(requestUrl);
    const generateBotUrl = `${botUrl.origin}/api/generate-bot`;

    const phase2Res = await fetch(generateBotUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Bot-Secret": env.TEAMS_APP_SECRET,
      },
      body: JSON.stringify({
        phase1Result,
        teamsServiceUrl: serviceUrl,
        teamsConversationId: convId,
        deckName: finalName,
      }),
    });

    await debugLog(env, "[phase1] Phase 2 fired — status:", phase2Res.status);
    await clearState(env, convId);
  } catch (err) {
    await debugLog(env, "handleGenerate ERROR:", err.message, err.stack);
    await sendText(
      env,
      serviceUrl,
      convId,
      `\u274C Generation failed: ${err.message}\n\nSay **new deck** to try again.`
    );
    await clearState(env, convId);
  }
}

async function handleBackToSelect(env, convId, serviceUrl, state, data) {
  if (!state) {
    await sendText(env, serviceUrl, convId, "Session expired. Say **new deck** to start again.");
    return;
  }

  // Prefer selections from card data
  const d = data || {};
  const selectedIntroIds = d._selectedIntroIds
    ? d._selectedIntroIds.split(",").filter(Boolean)
    : (state.selectedIntroIds || []);
  const selectedProjectKeys = d._selectedProjectKeys
    ? d._selectedProjectKeys.split(",").filter(Boolean)
    : (state.selectedProjectKeys || []);

  await setState(env, convId, { ...state, feature: "deck", step: "select", serviceUrl });

  // Pre-fill previous selections
  const preIntros = selectedIntroIds.join(",");
  const preProjects = selectedProjectKeys.join(",");
  const card = buildPageSelectionCard(state.locked, state.intros, state.projectGroups, preIntros, preProjects);
  await sendCard(env, serviceUrl, convId, card);
}

async function handleBackToCover(env, convId, serviceUrl, state, data) {
  if (!state) {
    await sendText(env, serviceUrl, convId, "Session expired. Say **new deck** to start again.");
    return;
  }

  const configRaw = await env.RF_STORE.get("config");
  const config = configRaw ? JSON.parse(configRaw) : {};

  // Prefer data from card submit
  const d = data || {};
  const author = d._author || state.author || "";
  const deckName = d._deckName || state.deckName || "";
  const clientName = d._clientName || state.clientName || "";
  const coverDate = d._coverDate || state.coverDate || "";

  // Also carry selections forward
  const selectedIntroIds = d._selectedIntroIds || (state.selectedIntroIds || []).join(",");
  const selectedProjectKeys = d._selectedProjectKeys || (state.selectedProjectKeys || []).join(",");
  const selectedIds = d._selectedIds || (state.selectedIds || []).join(",");

  await setState(env, convId, { ...state, feature: "deck", step: "cover", serviceUrl });

  const selections = { selectedIntroIds, selectedProjectKeys, selectedIds };
  const card = buildCoverInfoCard(config.teamName, { author, deckName, clientName, coverDate }, selections);
  await sendCard(env, serviceUrl, convId, card);
}

// ── Helpers ──

function normalizeServiceUrl(url) {
  if (!url) return "";
  return url.endsWith("/") ? url : url + "/";
}

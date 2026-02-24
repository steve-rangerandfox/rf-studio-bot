/**
 * Phase 2 deck generation endpoint for the Teams bot.
 * POST /api/generate-bot
 *
 * Two-phase architecture (each phase runs in its own 30s budget):
 *   Phase 1 (bot.js waitUntil): Export + modify + start import
 *   Phase 2 (this file):        Poll import completion + send result card
 *
 * Receives phase1Result + Teams delivery info from bot.js.
 * Returns 202 immediately; actual work runs in context.waitUntil().
 */

import { completeDeckImport } from "../../lib/deck/logic.js";
import { getAccessToken } from "../../lib/shared/auth.js";
import { buildResultCard } from "../../lib/deck/cards.js";

const INTERNAL_SECRET_HEADER = "X-Internal-Bot-Secret";

async function debugLog(env, ...args) {
  try {
    const raw = await env.RF_STORE.get("bot_debug_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ t: new Date().toISOString(), msg: args.map(String).join(" ") });
    while (logs.length > 100) logs.shift();
    await env.RF_STORE.put("bot_debug_logs", JSON.stringify(logs), { expirationTtl: 3600 });
  } catch (_) {}
}

async function sendTeamsMessage(env, serviceUrl, conversationId, body) {
  const token = await getAccessToken(env);
  return fetch(`${serviceUrl}v3/conversations/${conversationId}/activities`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    // Verify internal secret
    const secret = request.headers.get(INTERNAL_SECRET_HEADER);
    if (secret !== env.TEAMS_APP_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    const params = await request.json();
    const { phase1Result, teamsServiceUrl, teamsConversationId, deckName } = params;

    await debugLog(env, "[phase2] Accepted — importJobId:", phase1Result?.importJobId);

    // Return 202 immediately — Phase 2 work runs in waitUntil (own 30s budget)
    context.waitUntil(
      runPhase2(env, phase1Result, teamsServiceUrl, teamsConversationId, deckName)
    );

    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    await debugLog(env, "[phase2] Parse error:", err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function runPhase2(env, phase1Result, teamsServiceUrl, teamsConversationId, deckName) {
  try {
    const result = await completeDeckImport(env, phase1Result);

    await debugLog(env, "[phase2] SUCCESS designId:", result.designId, "pages:", result.pageCount);

    // Send result card back to Teams
    const card = buildResultCard({
      deckName: deckName || phase1Result.deckName,
      designId: result.designId,
      pageCount: result.pageCount,
      editUrl: result.editUrl,
      viewUrl: result.viewUrl,
    });

    const sendRes = await sendTeamsMessage(env, teamsServiceUrl, teamsConversationId, {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card,
      }],
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      await debugLog(env, "[phase2] sendCard FAILED:", sendRes.status, errText);
    } else {
      await debugLog(env, "[phase2] Result card sent OK");
    }
  } catch (err) {
    await debugLog(env, "[phase2] ERROR:", err.message, err.stack);

    // Send error message to Teams
    if (teamsServiceUrl && teamsConversationId) {
      try {
        await sendTeamsMessage(env, teamsServiceUrl, teamsConversationId, {
          type: "message",
          text: `\u274C Generation failed (phase 2): ${err.message}\n\nSay **new deck** to try again.`,
        });
      } catch (_) {}
    }
  }
}

/**
 * RF Studio Bot — Unified Teams Bot Entry Point
 *
 * Routes incoming Teams activities to the appropriate feature handler:
 *   /newproject, "project"  → Project Provisioner
 *   /storyboard, "script"   → Script-to-Storyboard
 *   help, menu, home        → Home card
 *
 * Cloudflare Pages Function: POST /api/bot (webhook), GET /api/bot (health)
 */

import { validateBotToken, getAccessToken } from "../../lib/shared/auth.js";
import { sendCard, sendText } from "../../lib/shared/send.js";
import { getState, clearState } from "../../lib/shared/state.js";
import { buildHomeCard } from "../../lib/home-card.js";
import { handleProvisionerText, handleProvisionerCard } from "../../lib/provisioner/handler.js";
import { handleStoryboardText, handleStoryboardCard } from "../../lib/storyboard/handler.js";

// ── GET /api/bot — health check & diagnostics ──
export async function onRequestGet(context) {
  const { env } = context;
  let hasConfig = false;
  try {
    if (env.RF_STORE) {
      const raw = await env.RF_STORE.get("config");
      hasConfig = !!raw;
    }
  } catch (_) {}

  return Response.json({
    status: "ok",
    bot: "RF Studio Bot",
    version: "1.0.0",
    features: ["project-provisioner", "script-storyboard"],
    devMode: env.BOT_DEV_MODE === "true",
    hasConfig,
    timestamp: new Date().toISOString(),
  });
}

// ── POST /api/bot — Teams webhook handler ──
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response("Invalid JSON", { status: 400 });
  }

  // ── Authenticate ──
  const authHeader = request.headers.get("Authorization") || "";
  if (env.BOT_DEV_MODE !== "true") {
    const valid = await validateBotToken(authHeader, env.TEAMS_APP_ID, env);
    if (!valid) {
      console.error("[bot] JWT validation failed");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const { type, text, value, conversation, serviceUrl, from } = body;
  const conversationId = conversation?.id;

  if (!conversationId || !serviceUrl) {
    return new Response("OK", { status: 200 });
  }

  try {
    // ── Activity routing ──
    if (type === "message" || type === "invoke") {
      let result;
      if (value && typeof value === "object" && value.action) {
        // Card submission
        result = await handleCardSubmission(context, body);
      } else if (text) {
        // Text message
        result = await handleTextMessage(context, body);
      } else if (body.attachments && body.attachments.length > 0) {
        // File attachment — route to storyboard (only feature that accepts files)
        result = await handleStoryboardText(context, body);
      }

      // Ensure we always return a proper Response (handlers may return undefined)
      if (result instanceof Response) return result;
      if (type === "invoke") {
        return Response.json({ status: 200 }, { status: 200 });
      }
      return new Response("OK", { status: 200 });
    }

    if (type === "conversationUpdate") {
      // Bot added to conversation — send welcome
      const added = body.membersAdded || [];
      const botId = body.recipient?.id;
      const isBot = added.some((m) => m.id === botId);
      if (isBot) {
        const token = await getAccessToken(env);
        if (token) {
          await sendCard(env, serviceUrl, conversationId, buildHomeCard());
        }
      }
    }
  } catch (err) {
    console.error("[bot] Error handling activity:", err.message || err);
    try {
      await sendText(env, serviceUrl, conversationId, `⚠️ Something went wrong: ${err.message}`);
    } catch (_) {}
  }

  // For invoke activities, return proper invoke response
  if (type === "invoke") {
    return Response.json({ status: 200 }, { status: 200 });
  }

  return new Response("OK", { status: 200 });
}

// ── Text message routing ──
async function handleTextMessage(context, activity) {
  const { env } = context;
  const rawText = (activity.text || "").replace(/<at>.*?<\/at>/g, "").trim();
  const text = rawText.toLowerCase();
  const conversationId = activity.conversation?.id;
  const serviceUrl = normalizeServiceUrl(activity.serviceUrl);

  // ── Global commands ──
  if (text === "help" || text === "home" || text === "menu" || text === "start" || text === "hi" || text === "hello") {
    await sendCard(env, serviceUrl, conversationId, buildHomeCard());
    return new Response("OK", { status: 200 });
  }

  if (text === "cancel" || text === "stop") {
    // Check if there's an active feature and let it handle cancellation
    const state = await getState(env, conversationId);
    if (state?.feature === "provisioner") return handleProvisionerText(context, activity);
    if (state?.feature === "storyboard") return handleStoryboardText(context, activity);
    // No active feature — just acknowledge
    await sendText(env, serviceUrl, conversationId, "Nothing to cancel. Type **help** to see what I can do.");
    return new Response("OK", { status: 200 });
  }

  // ── Feature-specific commands ──

  // Provisioner triggers
  if (text === "project" || text === "new project" || text === "/newproject" || text === "/project" ||
      text === "provision" || text.includes("new project") || text.includes("provision")) {
    return handleProvisionerText(context, activity);
  }

  // Storyboard triggers
  if (text === "storyboard" || text === "/storyboard" || text === "script" ||
      text.includes("storyboard") || text.includes("parse script")) {
    return handleStoryboardText(context, activity);
  }

  // ── Check active feature state ──
  const state = await getState(env, conversationId);
  if (state?.feature === "provisioner") return handleProvisionerText(context, activity);
  if (state?.feature === "storyboard") return handleStoryboardText(context, activity);

  // ── Fallback: show home card ──
  await sendCard(env, serviceUrl, conversationId, buildHomeCard());
  return new Response("OK", { status: 200 });
}

// ── Card submission routing ──
async function handleCardSubmission(context, activity) {
  const data = activity.value || {};
  const action = data.action || "";

  // Home card actions
  if (action === "startProvisioner") {
    return handleProvisionerText(context, { ...activity, text: "new project", value: undefined });
  }

  if (action === "startStoryboard") {
    return handleStoryboardText(context, { ...activity, text: "storyboard", value: undefined });
  }

  // Provisioner card action
  if (action === "provisionProject") {
    return handleProvisionerCard(context, activity);
  }

  // Storyboard card action
  if (action === "createStoryboard") {
    return handleStoryboardCard(context, activity);
  }

  // Unknown action — check state for active feature
  const conversationId = activity.conversation?.id;
  const state = await getState(context.env, conversationId);
  if (state?.feature === "provisioner") return handleProvisionerCard(context, activity);
  if (state?.feature === "storyboard") return handleStoryboardCard(context, activity);

  // Truly unknown — show home
  const serviceUrl = normalizeServiceUrl(activity.serviceUrl);
  await sendCard(context.env, serviceUrl, conversationId, buildHomeCard());
  return new Response("OK", { status: 200 });
}

// ── Helpers ──

function normalizeServiceUrl(url) {
  if (!url) return url;
  // Ensure exactly one trailing slash so v3/ paths append correctly
  return url.replace(/\/+$/, "") + "/";
}

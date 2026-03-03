/**
 * Provisioner feature handler for the unified RF Studio Bot.
 * Extracted from the standalone New Project Provisioner bot.js.
 *
 * Exports:
 *   handleProvisionerText(context, activity)  — text commands ("new project", etc.)
 *   handleProvisionerCard(context, activity)  — Adaptive Card submissions
 */

import { sendCard, sendText } from "../shared/send.js";
import { buildIntakeCard, buildSummaryCard, SERVICE_EMOJI } from "./cards.js";
import { runOrchestrator, ALL_SERVICES } from "./orchestrator.js";

// -- Helpers --

function normalizeServiceUrl(url) {
  if (!url) return "";
  return url.endsWith("/") ? url : url + "/";
}

// -- Form data parser --

function parseFormData(value) {
  const projectName = (value.projectName || "").trim();
  const clientName = (value.clientName || "").trim();
  const projectManager = (value.projectManager || "").trim();

  if (!projectName) throw new Error("Project Name is required.");
  if (!clientName) throw new Error("Client Name is required.");
  if (!projectManager) throw new Error("Project Manager email is required.");

  const teamMembersRaw = (value.teamMembers || "").trim();
  const teamMembers = teamMembersRaw
    ? teamMembersRaw.split(",").map((e) => e.trim()).filter(Boolean)
    : [];

  // Parse service toggles
  const selectedServices = [];
  const serviceKeys = [
    "dropbox", "frameio", "canva", "onedrive", "clockify", "figma", "notion", "teams",
  ];

  for (const key of serviceKeys) {
    if (value[`svc_${key}`] === "true") {
      selectedServices.push(key);
    }
  }

  // Fall back to ALL_SERVICES if nothing selected
  if (selectedServices.length === 0) {
    selectedServices.push(...ALL_SERVICES);
  }

  return {
    projectName,
    clientName,
    projectType: value.projectType || "Other",
    projectManager,
    teamMembers,
    startDate: value.startDate || undefined,
    deadline: value.deadline || undefined,
    description: value.description || undefined,
    selectedServices,
  };
}

// -- Provisioning runner (runs in background via waitUntil) --

async function runProvisioningAsync(env, convId, serviceUrl, form) {
  const selectedSet = new Set(form.selectedServices);

  const onProgress = async (phase, results) => {
    if (phase === "phase1_complete") {
      const lines = [];
      const phase1Keys = ["dropbox", "frameio", "canva", "onedrive", "clockify", "figma"];
      for (const key of phase1Keys) {
        const r = results[key];
        if (!r) continue;
        if (r.error === "skipped") {
          lines.push(`\u23ed\ufe0f ${SERVICE_EMOJI[key]}`);
        } else if (r.success) {
          lines.push(`\u2705 ${SERVICE_EMOJI[key]}`);
        } else {
          lines.push(`\u274c ${SERVICE_EMOJI[key]}`);
        }
      }
      await sendText(env, serviceUrl, convId, `**Phase 1 complete:**\n${lines.join("\n")}`);
    }
  };

  try {
    const results = await runOrchestrator(
      env,
      {
        form,
        conversationId: convId,
        serviceUrl,
        tenantId: env.TEAMS_TENANT_ID || "439235f0-c680-4a15-a7bd-2f766e97c5fe",
      },
      onProgress
    );

    // Send summary card
    const summaryCard = buildSummaryCard(
      form.projectName,
      form.clientName,
      results,
      selectedSet
    );

    await sendCard(env, serviceUrl, convId, summaryCard);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Provisioning failed:", message);
    await sendText(
      env,
      serviceUrl,
      convId,
      `\u274c **Provisioning failed:** ${message}\n\nPlease try again or contact support.`
    );
  }
}

// -- Public handlers --

/**
 * Handle text messages routed to the provisioner feature.
 * Recognises commands: "new project", "/newproject", "start", "cancel", "help".
 *
 * @param {object} context - Cloudflare Pages Functions context (env, waitUntil, etc.)
 * @param {object} activity - Bot Framework activity
 */
export async function handleProvisionerText(context, activity) {
  const { env } = context;
  const convId = activity.conversation?.id;
  const serviceUrl = normalizeServiceUrl(activity.serviceUrl);

  if (!convId || !serviceUrl) return new Response("OK", { status: 200 });

  const raw = (activity.text || "").replace(/<at>[^<]*<\/at>/gi, "").trim().toLowerCase();

  if (
    raw.includes("new project") ||
    raw.includes("/newproject") ||
    raw.includes("start") ||
    raw.includes("provision")
  ) {
    const card = buildIntakeCard();
    await sendCard(env, serviceUrl, convId, card);
  } else if (raw.includes("cancel") || raw.includes("stop")) {
    await sendText(
      env,
      serviceUrl,
      convId,
      "Cancelled. Say **new project** to start again."
    );
  } else if (raw.includes("help")) {
    await sendText(
      env,
      serviceUrl,
      convId,
      "**RF Project Provisioner Bot** \ud83c\udfac\n\n" +
        "Commands:\n" +
        "- **new project** \u2014 Start provisioning a new project\n" +
        "- **/newproject** \u2014 Same as above\n" +
        "- **cancel** \u2014 Cancel\n" +
        "- **help** \u2014 Show this message"
    );
  } else {
    await sendText(
      env,
      serviceUrl,
      convId,
      "Type **/newproject** or **new project** to start provisioning a new project."
    );
  }

  return new Response("OK", { status: 200 });
}

/**
 * Handle Adaptive Card submissions routed to the provisioner feature.
 * Currently handles the "provisionProject" action from the intake form.
 *
 * @param {object} context - Cloudflare Pages Functions context (env, waitUntil, etc.)
 * @param {object} activity - Bot Framework activity
 */
export async function handleProvisionerCard(context, activity) {
  const { env } = context;
  const convId = activity.conversation?.id;
  const serviceUrl = normalizeServiceUrl(activity.serviceUrl);

  if (!convId || !serviceUrl) return;

  // Extract card submit data — handle both message and invoke shapes
  const cardValue = activity.value;
  const data = cardValue?.data || cardValue;
  const action = data?.action || cardValue?.action;

  if (action === "provisionProject") {
    let form;
    try {
      form = parseFormData(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sendText(env, serviceUrl, convId, `\u274c Validation error: ${msg}`);
      return;
    }

    // Acknowledge with service list — do this in background too so we return HTTP 200 fast
    const serviceList = form.selectedServices
      .map((key) => SERVICE_EMOJI[key])
      .join(", ");

    // Fire-and-forget: send ack + run orchestrator in background
    context.waitUntil(
      (async () => {
        await sendText(
          env,
          serviceUrl,
          convId,
          `\ud83d\ude80 **Provisioning ${form.projectName} for ${form.clientName}** \u2014 creating: ${serviceList}\n\nThis may take 30\u201360 seconds...`
        );
        await runProvisioningAsync(env, convId, serviceUrl, form);
      })().catch(async (err) => {
        console.error("Unhandled provisioning error:", err.message, err.stack);
        try {
          await sendText(
            env, serviceUrl, convId,
            `\u274c **Provisioning crashed:** ${err.message || String(err)}\n\nPlease try again or contact support.`
          );
        } catch (_) { /* last resort — can't reach Teams */ }
      })
    );
  } else {
    await sendText(env, serviceUrl, convId, "Unknown action. Say **new project** to start over.");
  }

  // Return immediately so Teams doesn't retry
  return new Response("OK", { status: 200 });
}

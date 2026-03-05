/**
 * Storyboard feature handler for the unified RF Studio Bot.
 *
 * Exports two entry points consumed by the top-level router:
 *   handleStoryboardText(context, activity)  — text commands
 *   handleStoryboardCard(context, activity)  — Adaptive Card submissions
 *
 * All Teams I/O goes through the shared send module; conversation state
 * goes through the shared state module.
 */

import { sendCard, sendText, updateCard } from "../shared/send.js";
import { getState, setState, clearState } from "../shared/state.js";
import { getAccessToken } from "../shared/auth.js";
import { buildUploadPromptCard, buildSummaryCard } from "./cards.js";
import { runOrchestration, resumeJob } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Text message handler
// ---------------------------------------------------------------------------

/**
   * Handles text messages routed to the storyboard feature.
 *
 * Recognised commands:
 *   /storyboard | storyboard | "new storyboard" | script | start — show upload prompt card
 *   /storyboard resume {jobId} — resume a failed Boords job
 *   help — show help text
 *   cancel | stop — cancel current operation
 *
 * @param {object} context Cloudflare Pages Function context (has env, waitUntil)
 * @param {object} activity Bot Framework activity
 */
export async function handleStoryboardText(context, activity) {
    const { env } = context;
    const convId = activity.conversation?.id;
    const serviceUrl = normalizeServiceUrl(activity.serviceUrl);

  if (!convId || !serviceUrl) return;

  // Strip bot @mention tags and clean up
  const raw = (activity.text || "")
      .replace(/<at>[^<]*<\/at>/gi, "")
      .trim()
      .toLowerCase();

  if (
        raw === "/storyboard" ||
        raw === "storyboard" ||
        raw === "script" ||
        raw === "new storyboard" ||
        raw.includes("new storyboard") ||
        raw.includes("storyboard") ||
        raw === "start"
      ) {
        // Show the upload prompt card immediately
      await sendUploadPrompt(env, serviceUrl, convId);
  } else if (raw.startsWith("/storyboard resume ")) {
    const jobId = raw.replace("/storyboard resume ", "").trim();
        await handleResumeJob(env, convId, serviceUrl, jobId);
  } else if (raw.includes("help")) {
        await sendText(
                env,
                serviceUrl,
                convId,
                "**Script-to-Storyboard Bot**\n\n" +
                  "Commands:\n" +
                  "- **/storyboard** or **storyboard** \u2014 Start creating a storyboard\n" +
                "- **/storyboard resume {jobId}** \u2014 Resume a failed Boords job\n" +
                  "- **cancel** \u2014 Cancel the current operation\n" +
                  "- **help** \u2014 Show this message"
              );
  } else if (raw.includes("cancel") || raw.includes("stop")) {
        await clearState(env, convId);
        await sendText(
                env,
                serviceUrl,
                convId,
                "Operation cancelled. Say **storyboard** to start again."
              );
  } else {
        // Any unrecognised text — just show the card directly
      await sendUploadPrompt(env, serviceUrl, convId);
  }
          }

// ---------------------------------------------------------------------------
      // Card submission handler
// ---------------------------------------------------------------------------

/**
 * Handles Adaptive Card submissions routed to the storyboard feature.
 *
 * Currently the only recognised action is "createStoryboard", which
 * kicks off the full orchestration pipeline in the background via
 * context.waitUntil().
 *
   * @param {object} context Cloudflare Pages Function context (has env, waitUntil)
 * @param {object} activity Bot Framework activity (activity.value holds card data)
              */
export async function handleStoryboardCard(context, activity) {
    const { env } = context;
    const convId = activity.conversation?.id;
    const serviceUrl = normalizeServiceUrl(activity.serviceUrl);

  if (!convId || !serviceUrl) return;

  // Card data may arrive in activity.value or activity.value.data (invoke)
  const cardValue = activity.value?.data || activity.value;
    if (!cardValue) {
          await sendText(
                  env,
                  serviceUrl,
                  convId,
                  "Unknown action. Say **storyboard** to start over."
                );
          return;
    }

  const action = cardValue.action;

  if (action === "createStoryboard") {
    // Send immediate acknowledgment
      await sendText(
              env,
              serviceUrl,
              convId,
              `Starting storyboard creation for "${cardValue.projectName || "project"}"...\n` +
                `Mode: ${cardValue.extractionMode === "ai" ? "AI-Powered" : "Sentence Split"} | ` +
                `Style: ${cardValue.videoStyle || "Cinematic"} | Aspect: ${cardValue.aspectRatio || "16:9"}`
            );

      // Run the orchestration pipeline in the background
      context.waitUntil(
                                handleFormSubmission(env, convId, serviceUrl, cardValue, activity).catch(
                                          async (err) => {
                                                      console.error("Orchestration UNHANDLED:", err.message, err.stack);
                                                      try {
                                                                    await sendText(
              env,
                                                                      serviceUrl,
                                                                                    convId,
                                                                                    `Storyboard creation failed: ${err.message}`
            );
                                                      } catch (_) {}
                                          }
                                        )
            );
        return;
  }

                                    // Fallback for unrecognised card actions
  await sendText(
      env,
        serviceUrl,
        convId,
        "Unknown action. Say **storyboard** to start over."
      );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sends the initial upload prompt Adaptive Card.
 */
async function sendUploadPrompt(env, serviceUrl, convId) {
    const card = buildUploadPromptCard();
    await sendCard(env, serviceUrl, convId, card);
}

/**
 * Runs after the user submits the upload/settings card.
 * Validates inputs, downloads any file attachment, and kicks off orchestration.
 *
 * Runs inside context.waitUntil() so the HTTP response can return immediately.
 */
async function handleFormSubmission(env, convId, serviceUrl, formData, activity) {
    // Validate required fields
  const projectName = formData.projectName;
    if (!projectName || projectName.trim() === "") {
          await sendText(env, serviceUrl, convId, "Please provide a project name.");
          return;
    }

  const scriptText = formData.scriptText;

  // Check for file attachments on the activity
  const attachments = (activity && activity.attachments) || [];
    let scriptFile;
    if (attachments.length > 0) {
          const fileAttachment = attachments.find(
                  (a) => a.contentType !== "application/vnd.microsoft.card.adaptive"
                );
          if (fileAttachment && fileAttachment.contentUrl) {
                  try {
                            const fileBuffer = await downloadAttachment(env, fileAttachment);
                            scriptFile = {
          buffer: fileBuffer,
                                        mimeType: fileAttachment.contentType || "text/plain",
                                        fileName: fileAttachment.name || "script.txt",
        };
                  } catch (error) {
                    const message = error instanceof Error ? error.message : "Unknown download error";
                                      await sendText(
                                                  env,
                                                  serviceUrl,
                                        convId,
                                                  `Failed to download attached file: ${message}`
                                                );
                            return;
                  }
          }
    }

  // Must have either a file or pasted text
  if (!scriptFile && (!scriptText || scriptText.trim() === "")) {
        await sendText(
                env,
                serviceUrl,
                convId,
                "Please provide either a script file attachment or paste script text in the text field."
              );
        return;
  }

  // Build the intake form data
  const intake = {
        scriptFile,
        scriptText: scriptText || undefined,
        projectName: projectName.trim(),
        videoStyle: formData.videoStyle || "Cinematic",
        aspectRatio: formData.aspectRatio || "16:9",
        secondsPerFrame: parseInt(formData.secondsPerFrame || "5", 10) || 5,
        extractionMode: formData.extractionMode || "sentence",
  };

      // Run orchestration with THROTTLED progress callbacks.
  // Each sendText() is an outbound fetch to Bot Framework, which counts
  // against Cloudflare's subrequest limit (50 on free plan) and adds
  // ~300ms wall time per message. We throttle to max 1 message every 4s
  // unless it's a critical milestone (completion/failure).
  let lastProgressSent = 0;
  const THROTTLE_MS = 4000;
  const CRITICAL_KEYWORDS = ["complete", "failed", "error", "created with", "extracted", "parsed"];

  const orchestrationResult = await runOrchestration(
        env,
        intake,
        async (phase, message) => {
                const now = Date.now();
                const msgLower = message.toLowerCase();
                const isCritical = CRITICAL_KEYWORDS.some((kw) => msgLower.includes(kw));
                const elapsed = now - lastProgressSent;

                // Only send if critical milestone OR enough time has passed
                if (!isCritical && elapsed < THROTTLE_MS) {
                  console.log(`[storyboard] Throttled: [${phase}] ${message}`);
                  return;
                }

                try {
                          await sendText(
                                      env,
                                      serviceUrl,
                                      convId,
                                      `[${phase.toUpperCase()}] ${message}`
                                    );
                          lastProgressSent = Date.now();
                } catch (error) {
                          console.error("[storyboard] Failed to send progress update:", error);
                }
}
      );

  // Send final summary card
  const summaryCard = buildSummaryCard(orchestrationResult);
    await sendCard(env, serviceUrl, convId, summaryCard);
}

/**
       * Downloads a file attachment from Teams using the bot access token.
 */
async function downloadAttachment(env, attachment) {
    const url = attachment.contentUrl;
    if (!url) {
          throw new Error("Attachment has no content URL.");
    }

  // Get bot auth token for downloading from Teams
  const token = await getAccessToken(env);
    const response = await fetch(url, {
          headers: {
                  Authorization: `Bearer ${token}`,
          },
    });

  if (!response.ok) {
        throw new Error(
                `Failed to download attachment: ${response.status} ${response.statusText}`
              );
  }

  return await response.arrayBuffer();
}

    /**
 * Attempts to resume a previously failed Boords frame creation job.
 */
async function handleResumeJob(env, convId, serviceUrl, jobId) {
    await sendText(
          env,
          serviceUrl,
          convId,
          `Attempting to resume job: ${jobId}...`
        );
    try {
          const url = await resumeJob(env, jobId);
          await sendText(
                  env,
                  serviceUrl,
                  convId,
                  `Job resumed successfully! Boords storyboard: ${url}`
                );
    } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
          await sendText(
                  env,
                  serviceUrl,
                  convId,
                  `Failed to resume job: ${message}`
                );
    }
      }

  /**
 * Normalizes a Bot Framework service URL to always end with a trailing slash.
 */
function normalizeServiceUrl(url) {
    if (!url) return "";
    return url.endsWith("/") ? url : url + "/";
}

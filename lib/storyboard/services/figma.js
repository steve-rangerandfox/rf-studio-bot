/**
 * Figma service — triggers template duplication via Zapier webhook.
 *
 * The Figma REST API does not support file duplication or creation with
 * design content. We delegate to a Zapier automation that can use the
 * Figma integration (or Figma plugin) to duplicate a template file.
 *
 * This service:
 *   1. POSTs scene/layout data to a Zapier Catch Hook webhook
 *   2. Zapier handles Figma template duplication asynchronously
 *   3. Returns a link to the Figma template (or recents) for the user
 *
 * Required env var:
 *   ZAPIER_FIGMA_WEBHOOK — Zapier "Catch Hook" webhook URL
 *
 * Optional env vars:
 *   FIGMA_TEMPLATE_FILE_KEY — Figma file key for the template to duplicate
 *   FIGMA_TEMPLATE_URL — Full URL to the template (shown to user)
 *
 * Zapier Zap setup:
 *   Trigger: Webhooks by Zapier → Catch Hook
 *   Action:  Figma → Duplicate File (using template key + new name)
 *   Optional: Send a Teams notification with the new file link when done
 */

import { fetchT } from "../../provisioner/services/fetch-timeout.js";

/**
 * Triggers Figma script layout creation via Zapier webhook.
 *
 * @param {object} env - Cloudflare env with ZAPIER_FIGMA_WEBHOOK
 * @param {string} projectName - The project name
 * @param {Array} scenes - The extracted scene frames
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {Promise<string>} URL to Figma file or template
 */
export async function createFigmaScriptLayout(
  env,
  projectName,
  scenes,
  onProgress
) {
  const webhookUrl = env.ZAPIER_FIGMA_WEBHOOK;
  if (!webhookUrl) {
    throw new Error(
      "ZAPIER_FIGMA_WEBHOOK is not set. Please configure a Zapier Catch Hook URL."
    );
  }

  const templateFileKey = env.FIGMA_TEMPLATE_FILE_KEY || "";
  const templateUrl = env.FIGMA_TEMPLATE_URL || "";

  if (onProgress) {
    await onProgress("Figma: Sending to Zapier for layout creation...");
  }

  // Build the payload for Zapier — includes scene data and template info
  const payload = {
    projectName,
    fileName: `${projectName} — Script Layout`,
    templateFileKey,
    sceneCount: scenes.length,
    scenes: scenes.map((scene, i) => ({
      number: i + 1,
      title: scene.title || `Scene ${i + 1}`,
      voiceoverText: scene.voiceoverText || "",
      visualDescription: scene.visualDescription || "",
      shotType: scene.shotType || "",
      durationSeconds: scene.durationSeconds || 5,
    })),
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetchT(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Zapier webhook returned ${res.status}: ${errText}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Figma Zapier webhook failed: ${msg}`);
  }

  if (onProgress) {
    await onProgress("Figma: Zapier automation triggered — file will appear in Figma shortly.");
  }

  // Return the template URL if available, otherwise Figma recents
  if (templateUrl) {
    return templateUrl;
  }
  if (templateFileKey) {
    return `https://www.figma.com/file/${templateFileKey}`;
  }
  return "https://www.figma.com/files/recents-and-sharing";
}

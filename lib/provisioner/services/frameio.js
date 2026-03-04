/**
 * Frame.io provisioning — triggers project creation via Zapier webhook.
 *
 * The direct Frame.io v2 API calls were consuming too many subrequests
 * (1 project + 5 folder creations = 6+ fetches with retries). Delegating
 * to Zapier reduces this to a single fire-and-forget POST.
 *
 * Required env var:
 *   ZAPIER_FRAMEIO_WEBHOOK — Zapier "Catch Hook" webhook URL
 *
 * Zapier Zap setup:
 *   Trigger: Webhooks by Zapier → Catch Hook
 *   Action:  Frame.io → Create Project (using projectName, clientName)
 *   Action:  Frame.io → Create Folder (repeat for each subfolder)
 *   Optional: Send a Teams notification with the project link when done
 */

import { fetchT } from "./fetch-timeout.js";
import { logger } from "./logger.js";
import { FOLDER_STRUCTURE } from "./folder-structure.js";

/**
 * Provision a Frame.io project with standard subfolders via Zapier webhook.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, error?: string}>}
 */
export async function provisionFrameIo(env, projectName, clientName) {
  const service = "FrameIo";

  try {
    const webhookUrl = env.ZAPIER_FRAMEIO_WEBHOOK;
    if (!webhookUrl) {
      throw new Error(
        "ZAPIER_FRAMEIO_WEBHOOK is not set. Please configure a Zapier Catch Hook URL."
      );
    }

    const payload = {
      projectName: `${projectName} — ${clientName}`,
      clientName,
      folders: FOLDER_STRUCTURE.frameio,
      timestamp: new Date().toISOString(),
    };

    const res = await fetchT(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Zapier webhook returned ${res.status}: ${errText}`);
    }

    // Zapier handles the rest asynchronously — return a generic Frame.io link
    const url = "https://app.frame.io";
    logger.serviceResult(service, true, url);
    return { service, success: true, url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

/**
 * FigJam service — triggers storyboard board creation via Zapier webhook.
 *
 * The Figma/FigJam REST API does not support creating files with embedded
 * content (sticky notes, connectors) on non-Enterprise plans. We delegate
 * to a Zapier automation.
 *
 * This service:
 *   1. Builds a structured board layout (sticky notes with color coding)
 *   2. POSTs the layout data to a Zapier Catch Hook webhook
 *   3. Zapier handles FigJam board creation asynchronously
 *   4. Returns a link to FigJam for the user to check
 *
 * Required env var:
 *   ZAPIER_FIGJAM_WEBHOOK — Zapier "Catch Hook" webhook URL
 *
 * Color coding scheme:
 *   Yellow (#FFF9C4): Dialogue scenes (has voiceover text)
 *   Blue   (#BBDEFB): Visual-only / B-roll scenes (no voiceover)
 *   Green  (#C8E6C9): Transition scenes (title/desc contains transition keywords)
 *
 * Zapier Zap setup:
 *   Trigger: Webhooks by Zapier → Catch Hook
 *   Action:  Figma → Create FigJam board with sticky notes
 *   Optional: Send a Teams notification with the board link when done
 */

import { fetchT } from "../../provisioner/services/fetch-timeout.js";

/** Keywords that indicate a transition scene. */
const TRANSITION_KEYWORDS = [
  "transition", "fade", "dissolve", "wipe", "cut to",
  "crossfade", "title card", "slate", "bumper", "interstitial",
];

/**
 * Triggers FigJam storyboard board creation via Zapier webhook.
 *
 * @param {object} env - Cloudflare env with ZAPIER_FIGJAM_WEBHOOK
 * @param {string} projectName - The project name
 * @param {Array} scenes - The extracted scene frames
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {Promise<string>} URL to FigJam or fallback
 */
export async function createFigJamBoard(env, projectName, scenes, onProgress) {
  const webhookUrl = env.ZAPIER_FIGJAM_WEBHOOK;
  if (!webhookUrl) {
    throw new Error(
      "ZAPIER_FIGJAM_WEBHOOK is not set. Please configure a Zapier Catch Hook URL."
    );
  }

  if (onProgress) {
    await onProgress("FigJam: Sending to Zapier for board creation...");
  }

  // Build the payload with color-coded sticky note layout
  const payload = {
    projectName,
    boardName: `${projectName} — Storyboard Board`,
    sceneCount: scenes.length,
    colorScheme: {
      yellow: { hex: "#FFF9C4", meaning: "Dialogue scenes" },
      blue: { hex: "#BBDEFB", meaning: "Visual-only / B-roll" },
      green: { hex: "#C8E6C9", meaning: "Transition scenes" },
    },
    scenes: scenes.map((scene, i) => ({
      number: i + 1,
      title: scene.title || `Scene ${i + 1}`,
      voiceoverText: scene.voiceoverText || "",
      visualDescription: scene.visualDescription || "",
      shotType: scene.shotType || "",
      durationSeconds: scene.durationSeconds || 5,
      color: classifySceneColor(scene),
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
    throw new Error(`FigJam Zapier webhook failed: ${msg}`);
  }

  if (onProgress) {
    await onProgress("FigJam: Zapier automation triggered — board will appear in FigJam shortly.");
  }

  return "https://www.figma.com/figjam";
}

/**
 * Determines the sticky note color based on scene content.
 */
function classifySceneColor(scene) {
  const titleLower = (scene.title || "").toLowerCase();
  const descLower = (scene.visualDescription || "").toLowerCase();

  const isTransition = TRANSITION_KEYWORDS.some(
    (kw) => titleLower.includes(kw) || descLower.includes(kw)
  );
  if (isTransition) return "green";

  if (!scene.voiceoverText || scene.voiceoverText.trim() === "") return "blue";

  return "yellow";
}

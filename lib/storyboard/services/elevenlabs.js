/**
 * ElevenLabs service — triggers audiobook project creation via Zapier webhook.
 *
 * The ElevenLabs API requires whitelabel access, so we delegate the actual
 * project creation to a Zapier automation. This service:
 *   1. POSTs scene data to a Zapier Catch Hook webhook
 *   2. Zapier handles ElevenLabs project creation asynchronously
 *   3. Returns a link to ElevenLabs Studio for the user to check
 *
 * Required env var:
 *   ZAPIER_ELEVENLABS_WEBHOOK — Zapier "Catch Hook" webhook URL
 *
 * Zapier Zap setup:
 *   Trigger: Webhooks by Zapier → Catch Hook
 *   Action:  ElevenLabs → Create Project (using the received scene data)
 *   Optional: Send a Teams notification with the project link when done
 */

import { fetchT } from "../../provisioner/services/fetch-timeout.js";

/**
 * Triggers ElevenLabs audiobook project creation via Zapier webhook.
 *
 * @param {object} env - Cloudflare env with ZAPIER_ELEVENLABS_WEBHOOK
 * @param {string} projectName - The name for the Studio project
 * @param {Array} scenes - The extracted scene frames
 * @param {string} selectedVoiceId - The ElevenLabs voice ID
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @returns {Promise<string>} URL to ElevenLabs Studio
 */
export async function createElevenLabsProject(
  env,
  projectName,
  scenes,
  selectedVoiceId,
  onProgress
) {
  const webhookUrl = env.ZAPIER_ELEVENLABS_WEBHOOK;
  if (!webhookUrl) {
    throw new Error(
      "ZAPIER_ELEVENLABS_WEBHOOK is not set. Please configure a Zapier Catch Hook URL."
    );
  }

  if (onProgress) {
    await onProgress("ElevenLabs: Sending to Zapier for audiobook creation...");
  }

  // Build the payload for Zapier — includes everything needed to create
  // the ElevenLabs project in the Zap's action step
  const payload = {
    projectName,
    voiceId: selectedVoiceId,
    model: env.ELEVENLABS_DEFAULT_MODEL || "eleven_multilingual_v2",
    sceneCount: scenes.length,
    scenes: scenes.map((scene, i) => ({
      number: i + 1,
      title: scene.title || `Scene ${i + 1}`,
      voiceoverText: scene.voiceoverText || "",
    })),
    // Full script as a single block (useful if the Zap prefers a single text input)
    fullScript: scenes
      .map((s, i) => `[Scene ${i + 1}: ${s.title || ""}]\n${s.voiceoverText || ""}`)
      .join("\n\n"),
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
    throw new Error(`ElevenLabs Zapier webhook failed: ${msg}`);
  }

  if (onProgress) {
    await onProgress("ElevenLabs: Zapier automation triggered — project will appear in Studio shortly.");
  }

  // Return a link to ElevenLabs Studio — the project will appear there
  // once the Zapier automation completes
  return "https://elevenlabs.io/app/studio";
}

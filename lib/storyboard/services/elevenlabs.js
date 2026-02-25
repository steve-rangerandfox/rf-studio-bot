/**
 * ElevenLabs Studio API service — creates audiobook projects with scene content.
 *
 * Uses the ElevenLabs Studio API (POST /v1/studio/projects) with
 * multipart/form-data encoding. Content is passed via the
 * `from_content_json` parameter as a structured JSON array of chapters,
 * blocks, and nodes — not HTML.
 *
 * The old `/v1/projects/*` endpoints were deprecated Feb 2025 and
 * removed Jul 2025. This uses the current `/v1/studio/projects/*` API.
 *
 * API Reference:
 *   POST /v1/studio/projects  — Create a Studio project (multipart/form-data)
 *   GET  /v1/studio/projects  — List projects
 */

const BASE_URL = "https://api.elevenlabs.io/v1";

/**
 * Builds the `from_content_json` structure for the ElevenLabs Studio API.
 *
 * Each scene becomes a chapter with:
 *   - An h2 block for the scene title
 *   - A p block for the voiceover text
 *
 * @param {Array} scenes - Extracted scene frames
 * @param {string} voiceId - The ElevenLabs voice ID
 * @returns {Array} Array of chapter objects for from_content_json
 */
function buildContentJson(scenes, voiceId) {
  return scenes.map((scene, index) => {
    const blocks = [];

    // Title block (h2)
    if (scene.title) {
      blocks.push({
        sub_type: "h2",
        nodes: [
          {
            type: "tts_node",
            voice_id: voiceId,
            text: scene.title,
          },
        ],
      });
    }

    // Voiceover text block (paragraph)
    if (scene.voiceoverText) {
      blocks.push({
        sub_type: "p",
        nodes: [
          {
            type: "tts_node",
            voice_id: voiceId,
            text: scene.voiceoverText,
          },
        ],
      });
    }

    return {
      name: scene.title || `Scene ${index + 1}`,
      blocks,
    };
  });
}

/**
 * Builds a multipart/form-data body for the ElevenLabs API.
 *
 * Cloudflare Workers support the native FormData API.
 *
 * @param {object} fields - Key-value pairs to include in the form
 * @returns {FormData}
 */
function buildFormData(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      form.append(key, String(value));
    }
  }
  return form;
}

/**
 * Creates an ElevenLabs Studio audiobook project and populates it
 * with scene content in a single API call.
 *
 * The entire script is sent via `from_content_json` at project creation
 * time — no secondary content upload needed.
 *
 * @param {object} env - Cloudflare env with ELEVENLABS_API_KEY
 * @param {string} projectName - The name for the Studio project
 * @param {Array} scenes - The extracted scene frames
 * @param {string} selectedVoiceId - The ElevenLabs voice ID
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @returns {Promise<string>} The URL to the ElevenLabs Studio project
 */
export async function createElevenLabsProject(
  env,
  projectName,
  scenes,
  selectedVoiceId,
  onProgress
) {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY is not set. Please configure it in your environment."
    );
  }

  const defaultModel =
    env.ELEVENLABS_DEFAULT_MODEL || "eleven_multilingual_v2";

  // Build the structured content JSON from scenes
  if (onProgress) {
    await onProgress("ElevenLabs: Building audiobook content...");
  }

  const contentJson = buildContentJson(scenes, selectedVoiceId);

  // Create the Studio project with content in a single call
  if (onProgress) {
    await onProgress(
      `ElevenLabs: Creating audiobook with ${scenes.length} scenes...`
    );
  }

  const formData = buildFormData({
    name: projectName,
    default_title_voice_id: selectedVoiceId,
    default_paragraph_voice_id: selectedVoiceId,
    default_model_id: defaultModel,
    from_content_json: JSON.stringify(contentJson),
    source_type: "book",
    quality_preset: "standard",
  });

  const res = await fetch(`${BASE_URL}/studio/projects`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      // Do NOT set Content-Type — fetch sets it automatically
      // with the correct multipart boundary when given FormData
    },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `ElevenLabs API error (${res.status}): ${errText}`
    );
  }

  const projectData = await res.json();
  const projectId = projectData.project_id;

  const url = `https://elevenlabs.io/app/studio/${projectId}`;

  if (onProgress) {
    await onProgress("ElevenLabs: Audiobook project created!");
  }

  return url;
}

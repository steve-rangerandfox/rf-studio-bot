/**
 * ElevenLabs API service — creates Studio projects with scene content.
 * Uses native fetch instead of axios.
 */

const BASE_URL = "https://api.elevenlabs.io/v1";

/**
 * Makes an authenticated request to the ElevenLabs API.
 *
 * @param {object} env - Cloudflare env with ELEVENLABS_API_KEY
 * @param {string} path - API path
 * @param {object} options - fetch options override
 * @returns {Promise<object>} Parsed JSON response
 */
async function elevenLabsRequest(env, path, options = {}) {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY is not set. Please configure it in your environment."
    );
  }

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs API error (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Builds an HTML string from scene frames for ElevenLabs Studio content.
 *
 * Each scene becomes an <h2> heading (title) followed by a <p> paragraph
 * (voiceover text). Scenes without voiceover text are included with an
 * empty paragraph to maintain scene structure.
 */
function buildSceneHtml(scenes) {
  return scenes
    .map((scene) => {
      const title = escapeHtml(scene.title);
      const voiceover = escapeHtml(scene.voiceoverText);
      return `<h2>${title}</h2>\n<p>${voiceover}</p>`;
    })
    .join("\n\n");
}

/**
 * Escapes HTML special characters in a string.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Creates an ElevenLabs Studio project and populates it with scene content.
 *
 * Steps:
 * 1. POST /studio/projects to create the project with the selected voice.
 * 2. Build an HTML document from all scenes.
 * 3. POST /studio/projects/{id}/content with the HTML.
 *
 * @param {object} env - Cloudflare env with ELEVENLABS_API_KEY and ELEVENLABS_DEFAULT_MODEL
 * @param {string} projectName - The name for the ElevenLabs Studio project
 * @param {Array} scenes - The extracted scene frames
 * @param {string} selectedVoiceId - The ElevenLabs voice ID selected by the user
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
  const defaultModel =
    env.ELEVENLABS_DEFAULT_MODEL || "eleven_multilingual_v2";

  // Step 1: Create the Studio project
  if (onProgress) {
    await onProgress("Creating ElevenLabs Studio project...");
  }

  const projectData = await elevenLabsRequest(env, "/studio/projects", {
    method: "POST",
    body: {
      name: projectName,
      default_title_voice_id: selectedVoiceId,
      default_paragraph_voice_id: selectedVoiceId,
      default_model_id: defaultModel,
    },
  });

  const projectId = projectData.project_id;

  // Step 2: Build HTML content from scenes
  const htmlContent = buildSceneHtml(scenes);

  // Step 3: Upload content to the project
  if (onProgress) {
    await onProgress(
      `Uploading ${scenes.length} scenes to ElevenLabs Studio...`
    );
  }

  await elevenLabsRequest(env, `/studio/projects/${projectId}/content`, {
    method: "POST",
    body: {
      body: htmlContent,
    },
  });

  const url = `https://elevenlabs.io/app/studio/${projectId}`;

  if (onProgress) {
    await onProgress("ElevenLabs Studio project complete");
  }

  return url;
}

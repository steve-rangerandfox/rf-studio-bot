/**
 * Boords service — creates storyboards via the Boords REST API.
 *
 * Uses the Boords API at https://app.boords.com/api with X-API-KEY
 * authentication. Creates a project, storyboard, and frames in sequence.
 *
 * Each frame's voiceover/narration text maps to Boords' "Sound" field,
 * and the visual description maps to the "Action" field.
 *
 * NOTE: Boords does not have public API documentation (public API is
 * marked "In Progress" on their roadmap as of Feb 2026). This implementation
 * tries flat JSON first (matches Zapier integration field names), then
 * JSON:API format as fallback (common for Rails-based apps).
 *
 * API Endpoints:
 *   POST /api/projects          — Create a project
 *   POST /api/storyboards       — Create a storyboard in a project
 *   POST /api/frames            — Create a frame in a storyboard
 *   GET  /api/storyboards/{id}  — Get storyboard details (for edit_url)
 */

const BOORDS_BASE = "https://app.boords.com";
const BOORDS_API = `${BOORDS_BASE}/api`;

/**
 * Build common headers for Boords API requests.
 */
function apiHeaders(apiKey) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-KEY": apiKey,
  };
}

/**
 * Make a request to the Boords API with error handling.
 */
async function boordsRequest(method, path, apiKey, body = null) {
  const opts = {
    method,
    headers: apiHeaders(apiKey),
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BOORDS_API}${path}`, opts);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Boords API ${method} ${path} failed (${res.status}): ${errText}`);
  }

  // Some endpoints may return 204 No Content
  const contentType = res.headers.get("content-type") || "";
  if (res.status === 204 || !contentType.includes("json")) {
    return {};
  }

  return res.json();
}

/**
 * Extract an ID and attributes from a Boords response, handling
 * both flat JSON and JSON:API response formats.
 */
function extractFromResponse(result) {
  // JSON:API format: { data: { id, type, attributes: { ... } } }
  if (result.data && result.data.attributes) {
    return {
      id: result.data.id,
      ...result.data.attributes,
    };
  }
  // Flat format: { id, name, slug, ... }
  return result;
}

/**
 * Create a Boords project.
 *
 * @param {string} apiKey - Boords API key
 * @param {string} name - Project name
 * @returns {Promise<{id: string, name: string}>}
 */
async function createProject(apiKey, name) {
  let result;
  try {
    result = await boordsRequest("POST", "/projects", apiKey, { name });
  } catch (flatErr) {
    console.warn("[boords] Flat JSON failed for project creation, trying JSON:API:", flatErr.message);
    result = await boordsRequest("POST", "/projects", apiKey, {
      data: {
        type: "projects",
        attributes: { name },
      },
    });
  }

  const extracted = extractFromResponse(result);
  return {
    id: String(extracted.id),
    name: extracted.name || name,
  };
}

/**
 * Create a Boords storyboard inside a project.
 *
 * @param {string} apiKey - Boords API key
 * @param {string} projectId - Parent project ID
 * @param {string} name - Storyboard name
 * @returns {Promise<{id: string, slug: string, editUrl: string}>}
 */
async function createStoryboard(apiKey, projectId, name) {
  let result;
  try {
    result = await boordsRequest("POST", "/storyboards", apiKey, {
      name,
      project_id: projectId,
    });
  } catch (flatErr) {
    console.warn("[boords] Flat JSON failed for storyboard creation, trying JSON:API:", flatErr.message);
    result = await boordsRequest("POST", "/storyboards", apiKey, {
      data: {
        type: "storyboards",
        attributes: { name },
        relationships: {
          project: {
            data: { type: "projects", id: String(projectId) },
          },
        },
      },
    });
  }

  const extracted = extractFromResponse(result);
  return {
    id: String(extracted.id),
    slug: extracted.slug || "",
    editUrl: extracted.edit_url || extracted.editUrl ||
      `${BOORDS_BASE}/storyboards/${extracted.slug || extracted.id}`,
  };
}

/**
 * Create a single frame in a Boords storyboard.
 *
 * @param {string} apiKey - Boords API key
 * @param {string} storyboardId - Parent storyboard ID
 * @param {object} frameData - Frame attributes
 * @param {string} frameData.number - Frame number (as string)
 * @param {string} frameData.sound - Voiceover/narration text (maps to Sound field)
 * @param {string} frameData.action - Visual/action description (maps to Action field)
 * @param {string} [frameData.label] - Frame label/title
 * @returns {Promise<{id: string, number: string}>}
 */
async function createFrame(apiKey, storyboardId, frameData) {
  let result;
  try {
    result = await boordsRequest("POST", "/frames", apiKey, {
      storyboard_id: storyboardId,
      number: String(frameData.number),
      sound: frameData.sound || "",
      action: frameData.action || "",
      label: frameData.label || null,
    });
  } catch (flatErr) {
    console.warn("[boords] Flat JSON failed for frame creation, trying JSON:API:", flatErr.message);
    result = await boordsRequest("POST", "/frames", apiKey, {
      data: {
        type: "frames",
        attributes: {
          number: String(frameData.number),
          sound: frameData.sound || "",
          action: frameData.action || "",
          label: frameData.label || null,
        },
        relationships: {
          storyboard: {
            data: { type: "storyboards", id: String(storyboardId) },
          },
        },
      },
    });
  }

  const extracted = extractFromResponse(result);
  return {
    id: String(extracted.id || ""),
    number: String(extracted.number || frameData.number),
  };
}

/**
 * Creates a complete Boords storyboard with frames from extracted scenes.
 *
 * Workflow:
 *   1. Create a Boords project
 *   2. Create a storyboard inside that project
 *   3. Create frames for each scene (sequentially, preserving order)
 *   4. Return the storyboard edit URL
 *
 * @param {object} env - Cloudflare env with BOORDS_API_KEY
 * @param {string} projectName - The name for the project and storyboard
 * @param {Array} scenes - The extracted scene frames
 * @param {string} aspectRatio - The desired aspect ratio (for storyboard name)
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @returns {Promise<{url: string, storyboardId: string}>}
 */
export async function createBoordsStoryboard(
  env,
  projectName,
  scenes,
  aspectRatio,
  onProgress
) {
  const apiKey = env.BOORDS_API_KEY;

  if (!apiKey) {
    throw new Error(
      "BOORDS_API_KEY is not set. Please configure it in your environment."
    );
  }

  // Step 1: Create project
  if (onProgress) {
    await onProgress("Boords: Creating project...");
  }

  const project = await createProject(apiKey, projectName);

  // Step 2: Create storyboard
  if (onProgress) {
    await onProgress("Boords: Creating storyboard...");
  }

  const storyboardName = aspectRatio
    ? `${projectName} (${aspectRatio})`
    : projectName;
  const storyboard = await createStoryboard(apiKey, project.id, storyboardName);

  // Step 3: Create frames sequentially (preserves scene order)
  if (onProgress) {
    await onProgress(
      `Boords: Creating ${scenes.length} frames...`
    );
  }

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    await createFrame(apiKey, storyboard.id, {
      number: String(i + 1),
      sound: scene.voiceoverText || "",
      action: scene.visualDescription || "",
      label: scene.title || `Frame ${i + 1}`,
    });

    // Progress update every 5 frames for large storyboards
    if (onProgress && (i + 1) % 5 === 0 && i + 1 < scenes.length) {
      await onProgress(
        `Boords: Created ${i + 1}/${scenes.length} frames...`
      );
    }
  }

  if (onProgress) {
    await onProgress(
      `Boords: Storyboard created with ${scenes.length} frames!`
    );
  }

  return {
    url: storyboard.editUrl,
    storyboardId: storyboard.id,
  };
}

/**
 * Resume frame creation for a partially-completed storyboard.
 *
 * @param {object} env - Cloudflare env with BOORDS_API_KEY
 * @param {object} jobState - Persisted state with storyboardId and remaining scenes
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @returns {Promise<string>} The storyboard edit URL
 */
export async function resumeBoordsFrameCreation(env, jobState, onProgress) {
  const apiKey = env.BOORDS_API_KEY;

  if (!apiKey) {
    throw new Error("BOORDS_API_KEY is not set.");
  }

  if (!jobState || !jobState.storyboardId) {
    if (onProgress) {
      await onProgress(
        "No storyboard state found. Please re-run the /storyboard command."
      );
    }
    return BOORDS_BASE;
  }

  const { storyboardId, remainingScenes, startIndex } = jobState;

  if (onProgress) {
    await onProgress(
      `Boords: Resuming frame creation (${remainingScenes.length} remaining)...`
    );
  }

  for (let i = 0; i < remainingScenes.length; i++) {
    const scene = remainingScenes[i];
    const frameNum = (startIndex || 0) + i + 1;

    await createFrame(apiKey, storyboardId, {
      number: String(frameNum),
      sound: scene.voiceoverText || "",
      action: scene.visualDescription || "",
      label: scene.title || `Frame ${frameNum}`,
    });
  }

  // Get the storyboard details for the edit URL
  let editUrl = `${BOORDS_BASE}/storyboards/${storyboardId}`;
  try {
    const sbData = await boordsRequest(
      "GET",
      `/storyboards/${storyboardId}`,
      apiKey
    );
    const extracted = extractFromResponse(sbData);
    editUrl = extracted.edit_url || extracted.editUrl ||
      `${BOORDS_BASE}/storyboards/${extracted.slug || storyboardId}`;
  } catch (_) {
    // Use fallback URL
  }

  if (onProgress) {
    await onProgress("Boords: Resume complete!");
  }

  return editUrl;
}

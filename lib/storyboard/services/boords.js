/**
 * Boords API service — creates storyboards and populates frames.
 * Uses native fetch instead of axios.
 */

const BASE_URL = "https://api.boords.com/v1";

/**
 * Maps aspect ratio values to Boords-compatible aspect ratio strings.
 */
function mapAspectRatio(ratio) {
  const mapping = {
    "16:9": "16:9",
    "9:16": "9:16",
    "1:1": "1:1",
    "4:3": "4:3",
  };
  return mapping[ratio] || "16:9";
}

/**
 * Makes an authenticated request to the Boords API.
 *
 * @param {object} env - Cloudflare env with BOORDS_API_TOKEN
 * @param {string} path - API path (e.g., "/storyboards")
 * @param {object} options - fetch options override
 * @returns {Promise<object>} Parsed JSON response
 */
async function boordsRequest(env, path, options = {}) {
  const token = env.BOORDS_API_TOKEN;
  if (!token) {
    throw new Error(
      "BOORDS_API_TOKEN is not set. Please configure it in your environment."
    );
  }

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Boords API error (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Creates a new storyboard on Boords and populates it with frames from extracted scenes.
 *
 * Frames are created sequentially to maintain the correct order. If a frame
 * creation fails mid-way, the error includes the last successful frame index
 * to support resumption.
 *
 * @param {object} env - Cloudflare env with BOORDS_API_TOKEN and RF_STORE
 * @param {string} projectName - The name for the new storyboard
 * @param {Array} scenes - The extracted scene frames
 * @param {string} aspectRatio - The desired aspect ratio
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
  // Step 1: Create the storyboard
  if (onProgress) {
    await onProgress("Creating Boords storyboard...");
  }

  const storyboardData = await boordsRequest(env, "/storyboards", {
    method: "POST",
    body: {
      name: projectName,
      aspect_ratio: mapAspectRatio(aspectRatio),
      frame_rate: 24,
    },
  });

  const storyboardId = String(storyboardData.id);

  // Step 2: Create frames sequentially to maintain order
  if (onProgress) {
    await onProgress(`Adding ${scenes.length} frames to storyboard...`);
  }

  let lastSuccessfulIndex = -1;

  for (const scene of scenes) {
    try {
      await boordsRequest(env, `/storyboards/${storyboardId}/frames`, {
        method: "POST",
        body: {
          position: scene.index,
          caption: scene.voiceoverText,
          action_notes: scene.visualDescription,
          duration: scene.durationSeconds,
        },
      });

      lastSuccessfulIndex = scene.index;

      if (onProgress && scene.index % 5 === 0 && scene.index > 0) {
        await onProgress(
          `Boords: ${scene.index + 1}/${scenes.length} frames created...`
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      const frameError = new Error(
        `Failed to create Boords frame at index ${scene.index}: ${message}`
      );
      frameError.storyboardId = storyboardId;
      frameError.lastSuccessfulFrameIndex = lastSuccessfulIndex;
      frameError.scenes = scenes;
      frameError.isBoordsFrameError = true;
      throw frameError;
    }
  }

  const url = `https://app.boords.com/s/${storyboardId}`;

  if (onProgress) {
    await onProgress(`Boords storyboard complete: ${scenes.length} frames`);
  }

  return { url, storyboardId };
}

/**
 * Resumes frame creation for a partially completed storyboard.
 *
 * @param {object} env - Cloudflare env with BOORDS_API_TOKEN
 * @param {object} jobState - Persisted state with storyboardId, scenes, lastSuccessfulFrameIndex
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @returns {Promise<string>} The URL to the completed storyboard
 */
export async function resumeBoordsFrameCreation(env, jobState, onProgress) {
  const { storyboardId, scenes, lastSuccessfulFrameIndex } = jobState;

  const remainingScenes = scenes.filter(
    (s) => s.index > lastSuccessfulFrameIndex
  );

  if (onProgress) {
    await onProgress(
      `Resuming Boords: ${remainingScenes.length} frames remaining (starting after index ${lastSuccessfulFrameIndex})...`
    );
  }

  for (const scene of remainingScenes) {
    await boordsRequest(env, `/storyboards/${storyboardId}/frames`, {
      method: "POST",
      body: {
        position: scene.index,
        caption: scene.voiceoverText,
        action_notes: scene.visualDescription,
        duration: scene.durationSeconds,
      },
    });

    if (onProgress && scene.index % 5 === 0) {
      await onProgress(
        `Boords resume: frame ${scene.index + 1}/${scenes.length}...`
      );
    }
  }

  return `https://app.boords.com/s/${storyboardId}`;
}

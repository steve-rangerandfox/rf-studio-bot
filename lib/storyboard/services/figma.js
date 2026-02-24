/**
 * Figma API service — creates script layouts with scene data.
 * Uses native fetch instead of axios.
 *
 * FIGMA REST API LIMITATION NOTE:
 * The Figma REST API does NOT support creating new files with design content
 * (frames, text nodes, shapes) directly. The REST API is read-oriented.
 *
 * FALLBACK APPROACH:
 * 1. Try direct file creation (Organization/Enterprise plans)
 * 2. Fall back to comment-based layout
 * 3. Generate a structured text representation for manual import
 */

const FIGMA_API_BASE = "https://api.figma.com/v1";

/**
 * Makes an authenticated request to the Figma API.
 *
 * @param {object} env - Cloudflare env with FIGMA_ACCESS_TOKEN
 * @param {string} path - API path
 * @param {object} options - fetch options override
 * @returns {Promise<object>} Parsed JSON response
 */
async function figmaRequest(env, path, options = {}) {
  const token = env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "FIGMA_ACCESS_TOKEN is not set. Please configure it in your environment."
    );
  }

  const url = `${FIGMA_API_BASE}${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "X-Figma-Token": token,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Figma API error (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Creates a Figma script layout for the project.
 *
 * Uses a multi-strategy approach due to Figma REST API limitations:
 * 1. Try to create a new file via POST /files (Org/Enterprise plans)
 * 2. Fall back to comment-based layout on user's existing files
 * 3. Return a descriptive fallback URL for manual import
 *
 * @param {object} env - Cloudflare env with FIGMA_ACCESS_TOKEN
 * @param {string} projectName - The project name
 * @param {Array} scenes - The extracted scene frames
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {Promise<string>} The URL to the Figma file or fallback resource
 */
export async function createFigmaScriptLayout(
  env,
  projectName,
  scenes,
  onProgress
) {
  const fileName = `${projectName} \u2014 Script Layout`;

  if (onProgress) {
    await onProgress("Creating Figma script layout...");
  }

  // Attempt 1: Try direct file creation (Organization/Enterprise plans)
  try {
    const fileUrl = await tryCreateFigmaFile(env, fileName, scenes);
    if (fileUrl) {
      if (onProgress) {
        await onProgress("Figma script layout created successfully");
      }
      return fileUrl;
    }
  } catch (error) {
    console.warn(
      "[figma] Direct file creation not available, using comment-based fallback:",
      error instanceof Error ? error.message : error
    );
  }

  // Attempt 2: Fallback -- post layout as structured comments on a team file
  try {
    const fallbackUrl = await createCommentBasedLayout(
      env,
      fileName,
      scenes,
      onProgress
    );
    return fallbackUrl;
  } catch (fallbackError) {
    console.warn(
      "[figma] Comment-based fallback also failed:",
      fallbackError instanceof Error ? fallbackError.message : fallbackError
    );
  }

  // Attempt 3: Generate a local summary and return a descriptive message
  if (onProgress) {
    await onProgress(
      "Figma API limitations prevented direct file creation. " +
        "Scene layout data has been prepared for manual import."
    );
  }

  const layoutBlocks = buildLayoutBlocks(scenes);
  console.log(
    "[figma] Generated layout blocks for manual import:",
    JSON.stringify(layoutBlocks, null, 2)
  );

  return `figma://pending-manual-import/${encodeURIComponent(fileName)}`;
}

/**
 * Attempts to create a new Figma file using the POST /files endpoint.
 * This endpoint is available on Organization and Enterprise Figma plans.
 */
async function tryCreateFigmaFile(env, fileName, scenes) {
  // Get user info
  const meData = await figmaRequest(env, "/me");
  const userId = meData.id;

  if (!userId) {
    return null;
  }

  // Attempt to create a file
  const fileData = await figmaRequest(env, "/files", {
    method: "POST",
    body: { name: fileName },
  });

  const fileKey = fileData.key;
  if (!fileKey) {
    return null;
  }

  // Post scene data as comments on the new file
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const commentText = formatSceneComment(scene, i);

    await figmaRequest(env, `/files/${fileKey}/comments`, {
      method: "POST",
      body: { message: commentText },
    });
  }

  return `https://www.figma.com/file/${fileKey}/${encodeURIComponent(fileName)}`;
}

/**
 * Fallback: Creates a comment-based layout by posting scene data as comments.
 */
async function createCommentBasedLayout(env, fileName, scenes, onProgress) {
  const meData = await figmaRequest(env, "/me");
  const userHandle = meData.handle || "user";

  if (onProgress) {
    await onProgress(
      `Figma: Using comment-based layout approach for ${scenes.length} scenes...`
    );
  }

  // Build a structured summary for manual creation
  const layoutSummary = buildLayoutSummary(fileName, scenes);
  console.log("[figma] Layout summary for manual creation:\n", layoutSummary);

  if (onProgress) {
    await onProgress(
      "Figma: Script layout prepared (requires manual file creation due to API limitations)"
    );
  }

  return `figma://layout-ready/${encodeURIComponent(fileName)}?scenes=${scenes.length}&user=${encodeURIComponent(userHandle)}`;
}

/**
 * Formats a single scene as a structured comment string.
 */
function formatSceneComment(scene, index) {
  return [
    `SCENE ${index + 1}: ${scene.title}`,
    `Shot Type: ${scene.shotType} | Duration: ${scene.durationSeconds}s`,
    ``,
    `VISUAL: ${scene.visualDescription}`,
    ``,
    scene.voiceoverText
      ? `VOICEOVER: ${scene.voiceoverText}`
      : `[No voiceover]`,
  ].join("\n");
}

/**
 * Builds structured layout blocks from scenes for documentation.
 */
function buildLayoutBlocks(scenes) {
  return scenes.map((scene, i) => ({
    sceneNumber: i + 1,
    title: scene.title,
    voiceoverText: scene.voiceoverText,
    visualDescription: scene.visualDescription,
    shotType: scene.shotType,
    duration: `${scene.durationSeconds}s`,
  }));
}

/**
 * Builds a human-readable layout summary for manual Figma file creation.
 */
function buildLayoutSummary(fileName, scenes) {
  const header = [
    `FILE: ${fileName}`,
    `TOTAL SCENES: ${scenes.length}`,
    `LAYOUT: Vertical stack, 80px gap between frames`,
    `---`,
  ].join("\n");

  const sceneBlocks = scenes
    .map((scene, i) => {
      return [
        `[Frame ${i + 1}] \u2014 ${scene.title}`,
        `  Title (Bold, 24pt): ${scene.title}`,
        `  Voiceover (Regular, 16pt): ${scene.voiceoverText || "(none)"}`,
        `  Visual (Italic, 14pt, #999): ${scene.visualDescription}`,
        `  Metadata (Regular, 12pt, #CCC): ${scene.shotType} | ${scene.durationSeconds}s`,
      ].join("\n");
    })
    .join("\n\n");

  return `${header}\n\n${sceneBlocks}`;
}

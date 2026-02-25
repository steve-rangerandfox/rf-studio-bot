/**
 * FigJam API service — creates storyboard boards with sticky notes for each scene.
 * Uses native fetch instead of axios.
 *
 * FIGJAM REST API LIMITATION NOTE:
 * Similar to Figma, the FigJam REST API does not support creating new files
 * with embedded content (sticky notes, connectors, shapes) directly.
 *
 * FALLBACK APPROACH:
 * 1. Try direct FigJam file creation (Organization/Enterprise plans)
 * 2. Fall back to comment-based sticky note simulation
 * 3. Generate a JSON-based board specification for plugin-based import
 *
 * COLOR CODING SCHEME:
 * - Yellow (#FFF9C4): Dialogue scenes (voiceoverText is non-empty)
 * - Blue (#BBDEFB): Visual-only / B-roll scenes (no voiceover text)
 * - Green (#C8E6C9): Transition scenes (title or description contains transition keywords)
 */

const FIGMA_API_BASE = "https://api.figma.com/v1";

/**
 * Keywords that indicate a transition scene.
 */
const TRANSITION_KEYWORDS = [
  "transition",
  "fade",
  "dissolve",
  "wipe",
  "cut to",
  "crossfade",
  "title card",
  "slate",
  "bumper",
  "interstitial",
];

/**
 * Makes an authenticated request to the Figma/FigJam API.
 *
 * @param {object} env - Cloudflare env with FIGMA_ACCESS_TOKEN
 * @param {string} path - API path
 * @param {object} options - fetch options override
 * @returns {Promise<object>} Parsed JSON response
 */
async function figjamRequest(env, path, options = {}) {
  const token = env.FIGMA_ACCESS_TOKEN || env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      "FIGMA_ACCESS_TOKEN (or FIGMA_TOKEN) is not set. Please configure it in your environment."
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
    throw new Error(`FigJam API error (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Creates a FigJam storyboard board populated with sticky notes for each scene.
 *
 * @param {object} env - Cloudflare env with FIGMA_ACCESS_TOKEN
 * @param {string} projectName - The project name
 * @param {Array} scenes - The extracted scene frames
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {Promise<string>} The URL to the FigJam board or fallback resource
 */
export async function createFigJamBoard(env, projectName, scenes, onProgress) {
  const boardName = `${projectName} \u2014 Storyboard Board`;

  if (onProgress) {
    await onProgress("Creating FigJam storyboard board...");
  }

  // Build the virtual board layout
  const stickies = buildStickyLayout(scenes);
  const connectors = buildConnectors(stickies);

  // Attempt 1: Try direct FigJam file creation
  try {
    const fileUrl = await tryCreateFigJamFile(env, boardName, scenes, stickies);
    if (fileUrl) {
      if (onProgress) {
        await onProgress("FigJam storyboard board created successfully");
      }
      return fileUrl;
    }
  } catch (error) {
    console.warn(
      "[figjam] Direct file creation not available:",
      error instanceof Error ? error.message : error
    );
  }

  // Attempt 2: Generate board specification for manual/plugin import
  const boardSpec = generateBoardSpec(boardName, stickies, connectors);

  console.log(
    "[figjam] Board specification for plugin import:",
    JSON.stringify(boardSpec, null, 2)
  );

  if (onProgress) {
    await onProgress(
      "FigJam: Board data prepared (requires plugin-based import due to API limitations)"
    );
  }

  return `figjam://board-ready/${encodeURIComponent(boardName)}?scenes=${scenes.length}`;
}

/**
 * Attempts to create a new FigJam file and post scene data as comments.
 */
async function tryCreateFigJamFile(env, boardName, scenes, stickies) {
  const fileData = await figjamRequest(env, "/files", {
    method: "POST",
    body: {
      name: boardName,
      editor_type: "figjam",
    },
  });

  const fileKey = fileData.key;
  if (!fileKey) {
    return null;
  }

  // Post each sticky note as a comment to simulate the board
  for (const sticky of stickies) {
    const colorLabel = getColorLabel(sticky.color);
    await figjamRequest(env, `/files/${fileKey}/comments`, {
      method: "POST",
      body: {
        message: `${colorLabel} ${sticky.content}`,
      },
    });
  }

  return `https://www.figma.com/file/${fileKey}/${encodeURIComponent(boardName)}`;
}

/**
 * Determines the sticky note color based on scene content.
 *
 * - Green: Transition scenes (keywords in title or description)
 * - Blue: Visual-only / B-roll (no voiceover text)
 * - Yellow: Dialogue scenes (has voiceover text)
 */
function classifySceneColor(scene) {
  const titleLower = scene.title.toLowerCase();
  const descLower = scene.visualDescription.toLowerCase();

  const isTransition = TRANSITION_KEYWORDS.some(
    (kw) => titleLower.includes(kw) || descLower.includes(kw)
  );
  if (isTransition) {
    return "green";
  }

  if (!scene.voiceoverText || scene.voiceoverText.trim() === "") {
    return "blue";
  }

  return "yellow";
}

/**
 * Builds a horizontal/grid layout of virtual sticky notes.
 * Stickies are arranged in rows with up to 8 columns.
 */
function buildStickyLayout(scenes) {
  const STICKY_WIDTH = 280;
  const STICKY_HEIGHT = 200;
  const GAP_X = 40;
  const GAP_Y = 60;
  const MAX_COLUMNS = 8;

  return scenes.map((scene, i) => {
    const col = i % MAX_COLUMNS;
    const row = Math.floor(i / MAX_COLUMNS);

    const content = formatStickyContent(scene, i);
    const color = classifySceneColor(scene);

    return {
      id: `sticky_${i}`,
      color,
      content,
      x: col * (STICKY_WIDTH + GAP_X),
      y: row * (STICKY_HEIGHT + GAP_Y),
      width: STICKY_WIDTH,
      height: STICKY_HEIGHT,
      sceneIndex: i,
    };
  });
}

/**
 * Formats the text content for a single sticky note.
 */
function formatStickyContent(scene, index) {
  const lines = [
    `Scene ${index + 1}: ${scene.title}`,
    `---`,
    scene.visualDescription,
  ];

  if (scene.voiceoverText && scene.voiceoverText.trim()) {
    lines.push(``, `VO: "${scene.voiceoverText}"`);
  }

  lines.push(``, `${scene.shotType} | ${scene.durationSeconds}s`);

  return lines.join("\n");
}

/**
 * Builds connectors between sequential sticky notes.
 */
function buildConnectors(stickies) {
  const connectors = [];

  for (let i = 0; i < stickies.length - 1; i++) {
    connectors.push({
      fromId: stickies[i].id,
      toId: stickies[i + 1].id,
    });
  }

  return connectors;
}

/**
 * Returns a color label indicator for comment-based fallback.
 */
function getColorLabel(color) {
  const labelMap = {
    yellow: "[DIALOGUE]",
    blue: "[VISUAL/B-ROLL]",
    green: "[TRANSITION]",
  };
  return labelMap[color] || "[SCENE]";
}

/**
 * Generates a portable board specification that can be consumed by a
 * FigJam plugin for proper sticky note and connector creation.
 */
function generateBoardSpec(boardName, stickies, connectors) {
  return {
    name: boardName,
    type: "figjam_board",
    colorScheme: {
      yellow: { hex: "#FFF9C4", meaning: "Dialogue scenes" },
      blue: { hex: "#BBDEFB", meaning: "Visual-only / B-roll" },
      green: { hex: "#C8E6C9", meaning: "Transition scenes" },
    },
    stickies: stickies.map((s) => ({
      id: s.id,
      color: s.color,
      content: s.content,
      position: { x: s.x, y: s.y },
      size: { width: s.width, height: s.height },
    })),
    connectors: connectors.map((c) => ({
      from: c.fromId,
      to: c.toId,
      style: "arrow",
    })),
  };
}

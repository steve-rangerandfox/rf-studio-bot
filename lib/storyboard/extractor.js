/**
 * Scene extraction using the Anthropic Claude API via direct fetch.
 * Does NOT use the Anthropic SDK — uses native fetch to avoid Node.js dependencies.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You are a professional script supervisor and storyboard pre-production specialist. Your job is to analyze video production scripts and break them into discrete visual scenes or shots suitable for storyboarding. For each scene/shot, extract: (1) a short frame title (5 words max), (2) visual description of what the camera should see (2-4 sentences, descriptive, present tense), (3) voiceover or dialogue text verbatim from script or empty string, (4) estimated duration in seconds, (5) shot type if determinable (wide, medium, close-up, insert, aerial, etc.). Return ONLY a valid JSON array with no markdown formatting, no explanation.`;

const STRICT_RETRY_PROMPT = `You MUST return ONLY a valid JSON array. No markdown code fences, no explanation, no comments.

The JSON schema for each element is:
{
  "index": <number, zero-based>,
  "title": <string, 5 words max>,
  "visualDescription": <string, 2-4 sentences, present tense>,
  "voiceoverText": <string, verbatim from script or empty string>,
  "durationSeconds": <number>,
  "shotType": <string, e.g. "wide", "medium", "close-up", "insert", "aerial">
}

Return ONLY the JSON array. Begin your response with [ and end with ].`;

/**
 * Extracts structured scenes from raw script text using Claude.
 *
 * If the initial response cannot be parsed as JSON, retries once with a
 * stricter prompt demanding pure JSON output.
 *
 * @param {object} env - Cloudflare env with ANTHROPIC_API_KEY
 * @param {string} scriptText - The cleaned plain-text script content
 * @param {string} videoStyle - The video production style
 * @returns {Promise<Array>} Array of SceneFrame objects
 */
export async function extractScenes(env, scriptText, videoStyle) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Please configure it in your environment."
    );
  }

  const userPrompt = `Script style: ${videoStyle}\nScript content:\n${scriptText}`;

  // First attempt
  let responseText = await callClaude(apiKey, SYSTEM_PROMPT, userPrompt);
  let scenes = tryParseScenes(responseText);

  if (scenes) {
    return normalizeScenes(scenes);
  }

  console.warn(
    "[sceneExtractor] First Claude response was not valid JSON. Retrying with strict prompt..."
  );

  // Second attempt with stricter instructions
  responseText = await callClaude(apiKey, STRICT_RETRY_PROMPT, userPrompt);
  scenes = tryParseScenes(responseText);

  if (scenes) {
    return normalizeScenes(scenes);
  }

  throw new Error(
    "Failed to extract scenes: Claude did not return valid JSON after two attempts. " +
      `Last response started with: "${responseText.substring(0, 200)}..."`
  );
}

/**
 * Calls Claude via direct fetch to the Anthropic API.
 *
 * @param {string} apiKey - The Anthropic API key
 * @param {string} systemPrompt - System prompt
 * @param {string} userPrompt - User prompt
 * @returns {Promise<string>} The text response from Claude
 */
async function callClaude(apiKey, systemPrompt, userPrompt) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Anthropic API error (${res.status}): ${errText}`
    );
  }

  const data = await res.json();

  // Extract text from the response content blocks
  const textBlocks = (data.content || []).filter(
    (block) => block.type === "text"
  );
  if (textBlocks.length === 0) {
    throw new Error("Claude returned no text content.");
  }

  return textBlocks.map((block) => block.text).join("");
}

/**
 * Attempts to parse a string as a JSON array of SceneFrame-like objects.
 * Returns null if parsing fails.
 */
function tryParseScenes(raw) {
  try {
    // Strip any markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "");
    }

    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      return null;
    }

    // Basic validation: each element must have at least title and visualDescription
    for (const item of parsed) {
      if (
        typeof item.title !== "string" ||
        typeof item.visualDescription !== "string"
      ) {
        return null;
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Normalizes scene data to ensure all fields are present and correctly typed.
 */
function normalizeScenes(raw) {
  return raw.map((scene, i) => ({
    index: typeof scene.index === "number" ? scene.index : i,
    title: String(scene.title || `Scene ${i + 1}`).substring(0, 50),
    visualDescription: String(scene.visualDescription || ""),
    voiceoverText: String(scene.voiceoverText || ""),
    durationSeconds:
      typeof scene.durationSeconds === "number" && scene.durationSeconds > 0
        ? scene.durationSeconds
        : 5,
    shotType: String(scene.shotType || "medium"),
  }));
}

/**
 * Simple sentence-based scene extraction.
 *
 * Splits the script text by sentence boundaries (period, exclamation, question
 * mark, or line break). Each sentence becomes one frame with the text placed
 * in voiceoverText (which maps to Boords' "Sound" field).
 *
 * No AI is required — this is a fast, deterministic extraction mode ideal for
 * voiceover scripts where each line should be its own storyboard frame.
 *
 * @param {string} scriptText - The raw script text
 * @param {number} [secondsPerFrame=5] - Default duration for each frame
 * @returns {Array} Array of SceneFrame objects
 */
export function extractScenesBySentence(scriptText, secondsPerFrame = 5) {
  // Split on sentence-ending punctuation or line breaks
  const sentences = scriptText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) {
    throw new Error("No sentences found in the script text.");
  }

  return sentences.map((sentence, i) => ({
    index: i,
    title: `Frame ${i + 1}`,
    visualDescription: "",
    voiceoverText: sentence,
    durationSeconds: secondsPerFrame,
    shotType: "medium",
  }));
}

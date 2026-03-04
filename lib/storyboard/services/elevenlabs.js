/**
 * ElevenLabs service — generates voiceover audio via the TTS API.
 *
 * Calls the ElevenLabs text-to-speech endpoint directly. The generated
 * audio is saved automatically to the user's ElevenLabs speech history,
 * where they can preview, download, or share it.
 *
 * Required env var:
 *   ELEVENLABS_API_KEY — ElevenLabs API key (xi-api-key)
 *
 * Optional env var:
 *   ELEVENLABS_DEFAULT_MODEL — Model ID (default: eleven_multilingual_v2)
 */

import { fetchT } from "../../provisioner/services/fetch-timeout.js";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

// ElevenLabs TTS has a character limit per request (~5000 for most plans).
// We stay a bit under the limit to be safe.
const MAX_CHARS_PER_REQUEST = 4500;

/**
 * Generates voiceover audio via ElevenLabs TTS API.
 *
 * The audio is automatically saved to the user's ElevenLabs speech history.
 * For short scripts this produces a single audio file; for long scripts
 * it generates multiple sequential segments.
 *
 * @param {object} env - Cloudflare env with ELEVENLABS_API_KEY
 * @param {string} projectName - The project name (used in progress messages)
 * @param {Array} scenes - The extracted scene frames
 * @param {string} selectedVoiceId - The ElevenLabs voice ID
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @returns {Promise<string>} URL to ElevenLabs speech history
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
      "ELEVENLABS_API_KEY is not set. Add your API key in the Cloudflare dashboard."
    );
  }

  // Build the full voiceover script from all scenes
  const fullScript = scenes
    .map((s) => s.voiceoverText || "")
    .filter(Boolean)
    .join("\n\n");

  if (!fullScript.trim()) {
    throw new Error("No voiceover text found in scenes.");
  }

  const modelId = env.ELEVENLABS_DEFAULT_MODEL || "eleven_multilingual_v2";

  if (onProgress) {
    await onProgress(`Generating voiceover audio (${fullScript.length} chars)...`);
  }

  // If script fits in a single request, generate one audio file
  if (fullScript.length <= MAX_CHARS_PER_REQUEST) {
    await generateTTS(apiKey, selectedVoiceId, modelId, fullScript);

    if (onProgress) {
      await onProgress("Voiceover generated! Check your ElevenLabs speech history.");
    }
  } else {
    // Chunk by scenes to stay under the character limit
    const chunks = chunkScenes(scenes, MAX_CHARS_PER_REQUEST);

    if (onProgress) {
      await onProgress(
        `Script is ${fullScript.length} chars — generating ${chunks.length} audio segments...`
      );
    }

    for (let i = 0; i < chunks.length; i++) {
      await generateTTS(apiKey, selectedVoiceId, modelId, chunks[i]);

      if (onProgress && i < chunks.length - 1) {
        await onProgress(`Generated segment ${i + 1}/${chunks.length}...`);
      }
    }

    if (onProgress) {
      await onProgress(`All ${chunks.length} voiceover segments generated!`);
    }
  }

  // Audio is saved in the user's ElevenLabs speech history
  return "https://elevenlabs.io/app/speech-synthesis/history";
}

/**
 * Calls the ElevenLabs TTS API for a single text chunk.
 * The audio is returned as the response body and also saved to the
 * user's speech history automatically.
 */
async function generateTTS(apiKey, voiceId, modelId, text) {
  const res = await fetchT(
    `${ELEVENLABS_API}/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
      // TTS generation can take 15-30s for long text
      timeoutMs: 30_000,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText}`);
  }

  // Drain the response body to ensure the request completes.
  // The audio is saved to the user's ElevenLabs history automatically.
  await res.arrayBuffer();
}

/**
 * Splits scenes into text chunks that fit within the character limit.
 * Each chunk contains one or more complete scene voiceover texts.
 */
function chunkScenes(scenes, maxChars) {
  const chunks = [];
  let current = "";

  for (const scene of scenes) {
    const text = scene.voiceoverText || "";
    if (!text.trim()) continue;

    // If adding this scene would exceed the limit, push current chunk
    if (current.length + text.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }

    // If a single scene exceeds the limit, push it as its own chunk
    // (ElevenLabs will handle it or return an error)
    if (text.length > maxChars && current.length === 0) {
      chunks.push(text.trim());
      continue;
    }

    current += (current ? "\n\n" : "") + text;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

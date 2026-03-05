/**
 * Orchestration pipeline for the script-to-storyboard workflow.
 *
 * Execution order:
 * 1. Parse the script (sequential -- everything depends on the text).
 * 2. Extract scenes via Claude (sequential -- all services depend on scene data).
 * 3. Create Boords storyboard with frames.
 *
 * Boords integration uses the direct REST API (JSON:API format).
 */

import { parseScript } from "./parser.js";
import { extractScenes, extractScenesBySentence } from "./extractor.js";
import { createBoordsStoryboard, resumeBoordsFrameCreation } from "./services/boords.js";

/**
 * Orchestrates the full script-to-storyboard pipeline.
 *
 * @param {object} env - Cloudflare env with all API keys and KV bindings
 * @param {object} formData - The intake form data from the Teams Adaptive Card
 * @param {string} formData.projectName - Human-readable project name
 * @param {string} [formData.scriptText] - Raw pasted script text
 * @param {object} [formData.scriptFile] - Uploaded script file
 * @param {ArrayBuffer} formData.scriptFile.buffer - File content
 * @param {string} formData.scriptFile.mimeType - MIME type
 * @param {string} formData.scriptFile.fileName - Original filename
 * @param {string} formData.videoStyle - Video production style
 * @param {string} formData.selectedVoiceId - ElevenLabs voice ID
 * @param {string} formData.aspectRatio - Target aspect ratio
 * @param {number} formData.secondsPerFrame - Default seconds per frame
 * @param {Function} onProgress - Callback for sending progress updates (phase, message)
 * @returns {Promise<object>} The orchestration result
 */
export async function runOrchestration(env, formData, onProgress) {
  const result = {
    projectName: formData.projectName,
    scenes: [],
    totalDurationSeconds: 0,
    errors: [],
  };

  // -- Phase 1: Parse Script --
  await onProgress("parsing", "Parsing script...");

  let scriptText;
  try {
    if (formData.scriptFile) {
      scriptText = await parseScript({
        buffer: formData.scriptFile.buffer,
        mimeType: formData.scriptFile.mimeType,
        fileName: formData.scriptFile.fileName,
      });
    } else if (formData.scriptText) {
      scriptText = await parseScript({ text: formData.scriptText });
    } else {
      throw new Error("No script file or text provided.");
    }

    if (!scriptText || scriptText.trim().length < 20) {
      throw new Error(
        "Script content is too short or empty. Please provide a more substantial script."
      );
    }

    await onProgress(
      "parsing",
      `Script parsed: ${scriptText.length} characters`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown parsing error";
    result.errors.push({ service: "Script Parser", message });
    await onProgress("parsing", `Script parsing failed: ${message}`);
    return result;
  }

  // -- Phase 2: Extract Scenes --
  const useSentenceSplit = formData.extractionMode === "sentence";

  await onProgress(
    "extraction",
    useSentenceSplit
      ? "Splitting script by sentence..."
      : "Extracting scenes with Claude AI..."
  );

  let scenes;
  try {
    if (useSentenceSplit) {
      scenes = extractScenesBySentence(
        scriptText,
        formData.secondsPerFrame || 5
      );
    } else {
      scenes = await extractScenes(env, scriptText, formData.videoStyle);
    }

    if (scenes.length === 0) {
      throw new Error("No scenes were extracted from the script.");
    }

    result.scenes = scenes;
    result.totalDurationSeconds = scenes.reduce(
      (sum, s) => sum + s.durationSeconds,
      0
    );

    await onProgress(
      "extraction",
      `Extracted ${scenes.length} scenes (${formatDuration(result.totalDurationSeconds)} total)`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown extraction error";
    result.errors.push({ service: "Scene Extractor", message });
    await onProgress("extraction", `Scene extraction failed: ${message}`);
    return result;
  }

  // -- Phase 3: Create Boords Storyboard --
  await onProgress("provisioning", "Creating Boords storyboard...");

  try {
    const boordsResult = await createBoordsStoryboard(
      env,
      formData.projectName,
      scenes,
      formData.aspectRatio,
      (msg) => onProgress("boords", msg)
    );
    result.boardsUrl = boordsResult.url;
    await onProgress("boords", "Boords: Complete");
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    result.errors.push({ service: "Boords", message: errorMessage });
    await onProgress("boords", `Boords: Failed — ${errorMessage}`);
  }

  await onProgress(
    "complete",
    `Orchestration complete. ${result.errors.length === 0 ? "All services succeeded." : `${result.errors.length} error(s) occurred.`}`
  );

  return result;
}

/**
 * Resumes a previously failed Boords frame creation job.
 *
 * @param {object} env - Cloudflare env with BOORDS_API_TOKEN and RF_STORE
 * @param {string} jobId - The job ID from the error message
 * @returns {Promise<string>} The completed storyboard URL
 */
export async function resumeJob(env, jobId) {
  if (!env.RF_STORE) {
    throw new Error("KV store not available. Cannot resume job.");
  }

  const raw = await env.RF_STORE.get(`job_${jobId}`);
  if (!raw) {
    throw new Error(
      `Job ${jobId} not found. It may have expired or never been stored.`
    );
  }

  const jobState = JSON.parse(raw);
  return resumeBoordsFrameCreation(env, jobState);
}

/**
 * Formats a duration in seconds as a human-readable string.
 */
function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

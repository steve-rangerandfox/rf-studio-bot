/**
 * Orchestration pipeline for the script-to-storyboard workflow.
 *
 * Execution order:
 * 1. Parse the script (sequential -- everything depends on the text).
 * 2. Extract scenes via Claude (sequential -- all services depend on scene data).
 * 3. Provision all four services in parallel via Promise.allSettled:
 *    - Boords storyboard
 *    - ElevenLabs Studio project
 *    - Figma script layout (if requested)
 *    - FigJam board (if requested)
 *
 * Partial success is valid -- each service is independent.
 *
 * Job state is persisted in KV (env.RF_STORE) for resume capability.
 */

import { parseScript } from "./parser.js";
import { extractScenes } from "./extractor.js";
import { createBoordsStoryboard, resumeBoordsFrameCreation } from "./services/boords.js";
import { createElevenLabsProject } from "./services/elevenlabs.js";
import { createFigmaScriptLayout } from "./services/figma.js";
import { createFigJamBoard } from "./services/figjam.js";

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
 * @param {boolean} formData.createFigmaAssets - Whether to create Figma/FigJam assets
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
  await onProgress("extraction", "Extracting scenes with Claude AI...");

  let scenes;
  try {
    scenes = await extractScenes(env, scriptText, formData.videoStyle);

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

  // -- Phase 3: Provision Services in Parallel --
  await onProgress("provisioning", "Provisioning storyboard assets...");

  const servicePromises = [];

  // Boords -- always included
  servicePromises.push({
    name: "Boords",
    promise: createBoordsStoryboard(
      env,
      formData.projectName,
      scenes,
      formData.aspectRatio,
      (msg) => onProgress("boords", msg)
    ).then((boordsResult) => {
      // Store job state in KV for potential resume
      const jobId = `boords_${Date.now()}`;
      if (env.RF_STORE) {
        env.RF_STORE.put(
          `job_${jobId}`,
          JSON.stringify({
            jobId,
            projectName: formData.projectName,
            storyboardId: boordsResult.storyboardId,
            scenes,
            lastSuccessfulFrameIndex: scenes.length - 1,
            completedAt: new Date().toISOString(),
          }),
          { expirationTtl: 86400 } // 24 hours
        );
      }
      return boordsResult.url;
    }),
  });

  // ElevenLabs -- always included
  servicePromises.push({
    name: "ElevenLabs",
    promise: createElevenLabsProject(
      env,
      formData.projectName,
      scenes,
      formData.selectedVoiceId,
      (msg) => onProgress("elevenlabs", msg)
    ),
  });

  // Figma -- only if requested
  if (formData.createFigmaAssets) {
    servicePromises.push({
      name: "Figma",
      promise: createFigmaScriptLayout(
        env,
        formData.projectName,
        scenes,
        (msg) => onProgress("figma", msg)
      ),
    });

    servicePromises.push({
      name: "FigJam",
      promise: createFigJamBoard(
        env,
        formData.projectName,
        scenes,
        (msg) => onProgress("figjam", msg)
      ),
    });
  }

  // Run all services in parallel
  const results = await Promise.allSettled(
    servicePromises.map((sp) => sp.promise)
  );

  // Process results
  for (let i = 0; i < results.length; i++) {
    const serviceResult = results[i];
    const serviceName = servicePromises[i].name;

    if (serviceResult.status === "fulfilled") {
      const url = serviceResult.value;

      switch (serviceName) {
        case "Boords":
          result.boardsUrl = url;
          break;
        case "ElevenLabs":
          result.elevenLabsUrl = url;
          break;
        case "Figma":
          result.figmaFileUrl = url;
          break;
        case "FigJam":
          result.figjamFileUrl = url;
          break;
      }

      await onProgress(
        serviceName.toLowerCase(),
        `${serviceName}: Complete`
      );
    } else {
      const error = serviceResult.reason;
      let errorMessage;

      if (error && error.isBoordsFrameError) {
        errorMessage = error.message;
        // Store partial job state for resumption
        const jobId = `boords_partial_${Date.now()}`;
        if (env.RF_STORE) {
          await env.RF_STORE.put(
            `job_${jobId}`,
            JSON.stringify({
              jobId,
              projectName: formData.projectName,
              storyboardId: error.storyboardId,
              scenes: error.scenes,
              lastSuccessfulFrameIndex: error.lastSuccessfulFrameIndex,
            }),
            { expirationTtl: 86400 }
          );
        }
        errorMessage += ` (Resume with: /storyboard resume ${jobId})`;
      } else {
        errorMessage =
          error instanceof Error ? error.message : "Unknown error";
      }

      result.errors.push({ service: serviceName, message: errorMessage });
      await onProgress(
        serviceName.toLowerCase(),
        `${serviceName}: Failed \u2014 ${errorMessage}`
      );
    }
  }

  // Mark skipped services
  if (!formData.createFigmaAssets) {
    await onProgress("figma", "Figma: Skipped (not requested)");
    await onProgress("figjam", "FigJam: Skipped (not requested)");
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

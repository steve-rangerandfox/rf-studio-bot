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
 * KV Checkpointing:
 * Frame creation is checkpointed to RF_STORE after every batch so that
 * if the Cloudflare Worker is evicted mid-run, the user can resume with
 * /storyboard resume {jobId}.  The KV key is `job_{jobId}` and expires
 * after 24 h (86400 s).
 *
 * Batch Parallelization:
 * Frames are created in parallel batches of 5 to stay well within the
 * Cloudflare 30-second CPU time limit (~3s/frame x 5 = ~3s per batch
 * instead of ~3s x 10 = 30s sequential).
 *
 * API Endpoints:
 *  POST /api/projects      — Create a project
 *  POST /api/storyboards   — Create a storyboard in a project
 *  POST /api/frames        — Create a frame in a storyboard
 *  GET  /api/storyboards/{id} — Get storyboard details (for edit_url)
 */

import { fetchT } from "../../provisioner/services/fetch-timeout.js";

const BOORDS_BASE = "https://app.boords.com";
const BOORDS_API = `${BOORDS_BASE}/api`;

/** KV TTL for job checkpoints: 24 hours */
const JOB_TTL_SECONDS = 86400;

/** Number of frames to create in parallel per batch */
const BATCH_SIZE = 5;

/**
 * Build common headers for Boords API requests.
 */
function apiHeaders(apiKey) {
    return {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
          // User-Agent required to pass Cloudflare bot protection on Boords
          "User-Agent": "RFStudioBot/1.0 (https://rf-studio-bot.pages.dev)",
    };
}

/**
 * Make a request to the Boords API with error handling.
 * Uses fetchT for a 15-second timeout to prevent Cloudflare worker eviction.
 */
async function boordsRequest(method, path, apiKey, body = null) {
  const opts = {
    method,
    headers: apiHeaders(apiKey),
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetchT(`${BOORDS_API}${path}`, opts);

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
          editUrl: extracted.edit_url || extracted.editUrl || `${BOORDS_BASE}/storyboards/${extracted.slug || extracted.id}`,
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
 * Persist a job checkpoint to KV so the run can be resumed if the
 * Worker is evicted before all frames are created.
 *
 * @param {object} kv - Cloudflare KV namespace (env.RF_STORE)
 * @param {string} jobId - Unique job identifier
 * @param {object} state - Job state to persist
 */
async function saveCheckpoint(kv, jobId, state) {
    if (!kv) return; // KV not available — skip silently
  try {
        await kv.put(`job_${jobId}`, JSON.stringify(state), {
                expirationTtl: JOB_TTL_SECONDS,
        });
  } catch (err) {
        console.warn("[boords] Failed to save checkpoint to KV:", err.message);
  }
}

/**
 * Creates a complete Boords storyboard with frames from extracted scenes.
 *
 * Workflow:
 * 1. Create a Boords project
 * 2. Create a storyboard inside that project
 * 3. Save an initial checkpoint to KV (so resume is possible even before frames start)
 * 4. Create frames in parallel batches of 5, checkpointing after each batch
 * 5. Delete the checkpoint on success (clean up KV)
 * 6. Return the storyboard edit URL
 *
 * If the Worker is evicted mid-run, the user can run:
 *   /storyboard resume {jobId}
 * to pick up from where it stopped.
 *
 * @param {object} env - Cloudflare env with BOORDS_API_KEY and RF_STORE
 * @param {string} projectName - The name for the project and storyboard
 * @param {Array} scenes - The extracted scene frames
 * @param {string} aspectRatio - The desired aspect ratio (for storyboard name)
 * @param {Function} [onProgress] - Optional callback for progress updates
 * @param {string} [jobId] - Job ID for KV checkpointing (generated if not provided)
 * @returns {Promise<{url: string, storyboardId: string}>}
 */
export async function createBoordsStoryboard(
    env,
    projectName,
    scenes,
    aspectRatio,
    onProgress,
    jobId
  ) {
    const apiKey = env.BOORDS_API_KEY;
    if (!apiKey) {
          throw new Error(
                  "BOORDS_API_KEY is not set. Please configure it in your environment."
                );
    }

  // Generate a stable job ID if none provided
  const activeJobId = jobId || `sb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const kv = env.RF_STORE || null;

  // Step 1: Create project (skip progress message to conserve subrequests)
    const project = await createProject(apiKey, projectName);

  // Step 2: Create storyboard
    const storyboardName = aspectRatio
      ? `${projectName} (${aspectRatio})`
          : projectName;
    const storyboard = await createStoryboard(apiKey, project.id, storyboardName);

  // Step 3: Save initial checkpoint before we start the frame loop
  await saveCheckpoint(kv, activeJobId, {
        jobId: activeJobId,
        storyboardId: storyboard.id,
        editUrl: storyboard.editUrl,
        remainingScenes: scenes,
        startIndex: 0,
        totalScenes: scenes.length,
        createdAt: new Date().toISOString(),
  });

  // Step 4: Create frames in parallel batches, checkpointing after each batch
  if (onProgress) {
        await onProgress(
                `Boords: Creating ${scenes.length} frames... (job: ${activeJobId})`
              );
  }

  for (let batchStart = 0; batchStart < scenes.length; batchStart += BATCH_SIZE) {
    const batch = scenes.slice(batchStart, batchStart + BATCH_SIZE);

    try {
      await Promise.all(
        batch.map((scene, i) => {
          const idx = batchStart + i;
          return createFrame(apiKey, storyboard.id, {
            number: String(idx + 1),
            sound: scene.voiceoverText || "",
            action: scene.visualDescription || "",
            label: scene.title || `Frame ${idx + 1}`,
          });
        })
      );
    } catch (batchErr) {
      // Save checkpoint with remaining scenes so the job can be resumed
      const remainingScenes = scenes.slice(batchStart);
      await saveCheckpoint(kv, activeJobId, {
            jobId: activeJobId,
            storyboardId: storyboard.id,
            editUrl: storyboard.editUrl,
            remainingScenes,
            startIndex: batchStart,
            totalScenes: scenes.length,
            failedAt: batchStart + 1,
            createdAt: new Date().toISOString(),
      });

      const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      throw new Error(
        `Boords frame creation stopped at batch starting frame ${batchStart + 1}/${scenes.length}: ${errMsg}. ` +
        `Resume with: /storyboard resume ${activeJobId}`
      );
    }

    // Checkpoint after each successful batch (remaining = scenes not yet created)
    const nextStart = batchStart + BATCH_SIZE;
    const remainingAfter = scenes.slice(nextStart);
    await saveCheckpoint(kv, activeJobId, {
          jobId: activeJobId,
          storyboardId: storyboard.id,
          editUrl: storyboard.editUrl,
          remainingScenes: remainingAfter,
          startIndex: nextStart,
          totalScenes: scenes.length,
          createdAt: new Date().toISOString(),
    });

    // Progress update only at the halfway point to conserve subrequests
    const created = Math.min(nextStart, scenes.length);
    const isHalfway = batchStart === 0 || (created >= scenes.length / 2 && created - BATCH_SIZE < scenes.length / 2);
    if (onProgress && isHalfway && created < scenes.length) {
      await onProgress(
        `Boords: Created ${created}/${scenes.length} frames...`
      );
    }
  }

  // Step 5: All frames created — delete checkpoint (clean up KV)
  if (kv) {
    try {
      await kv.delete(`job_${activeJobId}`);
    } catch (_) {
      // Non-fatal — checkpoint will expire naturally
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
 * @param {object} env - Cloudflare env with BOORDS_API_KEY and RF_STORE
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

  const { storyboardId, remainingScenes, startIndex, jobId, editUrl } = jobState;
    const kv = env.RF_STORE || null;

  if (!remainingScenes || remainingScenes.length === 0) {
        if (onProgress) {
                await onProgress("Boords: All frames already created — nothing to resume.");
        }
        return editUrl || `${BOORDS_BASE}/storyboards/${storyboardId}`;
  }

  if (onProgress) {
        await onProgress(
                `Boords: Resuming frame creation (${remainingScenes.length} remaining, starting at frame ${(startIndex || 0) + 1})...`
              );
  }

  for (let batchStart = 0; batchStart < remainingScenes.length; batchStart += BATCH_SIZE) {
    const batch = remainingScenes.slice(batchStart, batchStart + BATCH_SIZE);

    try {
      await Promise.all(
        batch.map((scene, i) => {
          const frameNum = (startIndex || 0) + batchStart + i + 1;
          return createFrame(apiKey, storyboardId, {
            number: String(frameNum),
            sound: scene.voiceoverText || "",
            action: scene.visualDescription || "",
            label: scene.title || `Frame ${frameNum}`,
          });
        })
      );
    } catch (batchErr) {
      // Save checkpoint with remaining scenes so the job can be resumed again
      if (jobId && kv) {
        const stillRemaining = remainingScenes.slice(batchStart);
        await saveCheckpoint(kv, jobId, {
          ...jobState,
          remainingScenes: stillRemaining,
          startIndex: (startIndex || 0) + batchStart,
          failedAt: (startIndex || 0) + batchStart + 1,
        });
      }
      const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      throw new Error(
        `Resume stopped at batch starting frame ${(startIndex || 0) + batchStart + 1}: ${errMsg}. ` +
        (jobId ? `Try again with: /storyboard resume ${jobId}` : "")
      );
    }

    // Checkpoint after each successful batch
    if (jobId && kv) {
      const nextStart = batchStart + BATCH_SIZE;
      const stillRemaining = remainingScenes.slice(nextStart);
      await saveCheckpoint(kv, jobId, {
        ...jobState,
        remainingScenes: stillRemaining,
        startIndex: (startIndex || 0) + nextStart,
      });
    }
  }

  // All done — delete checkpoint
  if (jobId && kv) {
        try {
                await kv.delete(`job_${jobId}`);
        } catch (_) {}
  }

  // Return the known editUrl or fetch it from the API
  if (editUrl) {
        if (onProgress) await onProgress("Boords: Resume complete!");
        return editUrl;
  }

  let finalEditUrl = `${BOORDS_BASE}/storyboards/${storyboardId}`;
    try {
          const sbData = await boordsRequest(
                  "GET",
                  `/storyboards/${storyboardId}`,
                  apiKey
                );
          const extracted = extractFromResponse(sbData);
          finalEditUrl =
                  extracted.edit_url ||
                  extracted.editUrl ||
                  `${BOORDS_BASE}/storyboards/${extracted.slug || storyboardId}`;
    } catch (_) {
          // Use fallback URL
    }

  if (onProgress) await onProgress("Boords: Resume complete!");
    return finalEditUrl;
}

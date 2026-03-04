/**
 * 4-phase provisioning orchestrator.
 * Coordinates parallel and sequential provisioning across all 8 services.
 * All functions receive `env` for Cloudflare Workers environment bindings.
 */

import { provisionDropbox } from "./services/dropbox.js";
import { provisionFrameIo } from "./services/frameio.js";
import { provisionOneDrive } from "./services/onedrive.js";
import { provisionClockify } from "./services/clockify.js";
import { createNotionPage, patchNotionPageWithLinks } from "./services/notion.js";
import { provisionTeamsChat } from "./services/teams-chat.js";
import { logger } from "./services/logger.js";

const ALL_SERVICES = [
  "dropbox", "frameio", "onedrive", "clockify", "notion", "teams",
];

function skipped(serviceName) {
  return { service: serviceName, success: false, error: "skipped" };
}

function statusIcon(result) {
  if (!result) return "\u2753";
  if (result.error === "skipped") return "\u23ed\ufe0f";
  return result.success ? "\u2705" : "\u274c";
}

/**
 * Run the full provisioning orchestration.
 * @param {object} env - Cloudflare env bindings
 * @param {object} ctx - { form, conversationId, serviceUrl, tenantId }
 * @param {function} [onProgress] - Optional callback (phase, results) => void
 * @returns {Promise<object>} results keyed by service
 */
export async function runOrchestrator(env, ctx, onProgress) {
  const { form } = ctx;
  const sel = new Set(form.selectedServices);
  const results = {};

  function maybeRun(key, fn, fallbackName) {
    if (sel.has(key)) {
      return fn();
    }
    return Promise.resolve(skipped(fallbackName));
  }

  // -- Phase 1: Parallel provisioning (4 services) --
  const phase1 = await Promise.allSettled([
    maybeRun("dropbox", () => provisionDropbox(env, form.projectName, form.clientName), "Dropbox"),
    maybeRun("frameio", () => provisionFrameIo(env, form.projectName, form.clientName), "FrameIo"),
    maybeRun("onedrive", () => provisionOneDrive(env, form.projectName, form.clientName), "OneDrive"),
    maybeRun("clockify", () => provisionClockify(env, form.projectName, form.clientName), "Clockify"),
  ]);

  const keys = ["dropbox", "frameio", "onedrive", "clockify"];
  const names = ["Dropbox", "FrameIo", "OneDrive", "Clockify"];

  phase1.forEach((settled, i) => {
    const key = keys[i];
    if (settled.status === "fulfilled") {
      results[key] = settled.value;
    } else {
      results[key] = {
        service: names[i],
        success: false,
        error: settled.reason?.message ?? String(settled.reason),
      };
    }
  });

  logger.info(
    `Phase 1 complete: ${keys.map((k) => `${statusIcon(results[k])} ${k}`).join(", ")}`
  );

  if (onProgress) {
    await onProgress("phase1_complete", { ...results });
  }

  // -- Phase 2: Notion --
  if (sel.has("notion")) {
    results.notion = await createNotionPage(env, form);
  } else {
    results.notion = skipped("Notion");
  }

  logger.info(`Phase 2 complete: ${statusIcon(results.notion)} notion`);

  if (onProgress) {
    await onProgress("phase2_complete", { ...results });
  }

  // -- Phase 3: Teams Chat --
  if (sel.has("teams")) {
    results.teams = await provisionTeamsChat(env, form);
  } else {
    results.teams = skipped("Teams");
  }

  logger.info(`Phase 3 complete: ${statusIcon(results.teams)} teams`);

  if (onProgress) {
    await onProgress("phase3_complete", { ...results });
  }

  // -- Phase 4: Patch Notion with links from other services --
  if (sel.has("notion") && results.notion?.success && results.notion.id) {
    const links = {
      dropboxUrl: results.dropbox?.success ? results.dropbox.url : undefined,
      frameioUrl: results.frameio?.success ? results.frameio.url : undefined,
      teamsUrl: results.teams?.success ? results.teams.url : undefined,
      onedriveUrl: results.onedrive?.success ? results.onedrive.url : undefined,
      clockifyUrl: results.clockify?.success ? results.clockify.url : undefined,
    };

    await patchNotionPageWithLinks(env, results.notion.id, links);
    logger.info("Phase 4 complete: Notion page patched with links");
  } else {
    logger.info("Phase 4 skipped: Notion not selected or failed");
  }

  if (onProgress) {
    await onProgress("phase4_complete", { ...results });
  }

  return results;
}

export { ALL_SERVICES };

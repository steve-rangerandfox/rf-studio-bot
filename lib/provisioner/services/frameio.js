/**
 * Frame.io provisioning — create project and subfolders.
 * Uses native fetch. Receives env for credentials.
 *
 * NOTE: Frame.io v2 API is deprecated in favour of v4 (developer.frame.io).
 * v2 still works with developer tokens as of Feb 2026. Migrate to v4 when
 * v2 is fully retired.
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { fetchT } from "./fetch-timeout.js";
import { FOLDER_STRUCTURE } from "./folder-structure.js";

/**
 * Provision a Frame.io project with standard subfolders.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function provisionFrameIo(env, projectName, clientName) {
  const service = "FrameIo";

  try {
    const token = env.FRAMEIO_TOKEN;
    const teamId = env.FRAMEIO_TEAM_ID;

    if (!token || !teamId) {
      throw new Error("Missing FRAMEIO_TOKEN or FRAMEIO_TEAM_ID");
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Step 1: Create project
    const projectData = await withRetry(
      async () => {
        const res = await fetchT(`https://api.frame.io/v2/teams/${teamId}/projects`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: `${projectName} \u2014 ${clientName}`,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Frame.io create project failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Frame.io create project retry #${attempt}`, { error: err.message }),
      }
    );

    const projectId = projectData.id;
    const rootAssetId = projectData.root_asset_id;

    // Step 2: Create subfolders in parallel
    const folderNames = FOLDER_STRUCTURE.frameio;

    await Promise.all(
      folderNames.map((folderName) =>
        withRetry(
          async () => {
            const res = await fetchT(`https://api.frame.io/v2/assets/${rootAssetId}/children`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                name: folderName,
                type: "folder",
              }),
            });
            if (!res.ok) {
              const text = await res.text();
              throw new Error(`Frame.io folder "${folderName}" failed (${res.status}): ${text}`);
            }
            return res.json();
          },
          {
            onRetry: (err, attempt) =>
              logger.warn(`Frame.io folder "${folderName}" retry #${attempt}`, {
                error: err.message,
              }),
          }
        )
      )
    );

    const url = `https://app.frame.io/projects/${projectId}`;
    logger.serviceResult(service, true, url);
    return { service, success: true, url, id: projectId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

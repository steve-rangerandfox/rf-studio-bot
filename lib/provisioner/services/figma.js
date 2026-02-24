/**
 * Figma/FigJam provisioning — duplicate template file and rename.
 * Uses native fetch. Receives env for credentials.
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";

/**
 * Provision a FigJam board by duplicating a template file.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function provisionFigma(env, projectName, clientName) {
  const service = "FigJam";

  try {
    const figmaToken = env.FIGMA_TOKEN;
    const templateFileKey = env.FIGMA_TEMPLATE_FILE_KEY;

    if (!figmaToken || !templateFileKey) {
      throw new Error("Missing FIGMA_TOKEN or FIGMA_TEMPLATE_FILE_KEY");
    }

    const headers = {
      "X-Figma-Token": figmaToken,
      "Content-Type": "application/json",
    };

    // Step 1: Duplicate the template file
    const duplicateData = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.figma.com/v1/files/${templateFileKey}/duplicate`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          }
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Figma duplicate failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Figma duplicate retry #${attempt}`, { error: err.message }),
      }
    );

    const newFileKey = duplicateData.key;
    const newTitle = `${projectName} \u2014 ${clientName} \u2014 FigJam`;

    // Step 2: Rename the duplicated file
    await withRetry(
      async () => {
        const res = await fetch(`https://api.figma.com/v1/files/${newFileKey}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: newTitle }),
        });
        // Figma PATCH may return 200 or 204 depending on version
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Figma rename failed (${res.status}): ${text}`);
        }
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Figma rename retry #${attempt}`, { error: err.message }),
      }
    );

    const url = `https://www.figma.com/file/${newFileKey}`;
    logger.serviceResult(service, true, url);
    return { service, success: true, url, id: newFileKey };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

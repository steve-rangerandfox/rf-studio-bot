/**
 * Figma/FigJam provisioning — verify template and return link.
 * Uses native fetch. Receives env for credentials.
 *
 * NOTE: The Figma REST API does not expose a file-duplicate endpoint.
 * We verify the template exists and return a direct link so the user
 * can duplicate it manually from the Figma UI (right-click → Duplicate).
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { fetchT } from "./fetch-timeout.js";

/**
 * Provision a FigJam board by verifying the template and returning its link.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string, note?: string}>}
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
    };

    // Verify the template file exists and is accessible
    const fileData = await withRetry(
      async () => {
        const res = await fetchT(
          `https://api.figma.com/v1/files/${templateFileKey}?depth=1`,
          { headers }
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Figma template check failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Figma template check retry #${attempt}`, { error: err.message }),
      }
    );

    const templateName = fileData.name || "FigJam Template";
    const url = `https://www.figma.com/file/${templateFileKey}`;

    logger.serviceResult(service, true, url);
    return {
      service,
      success: true,
      url,
      id: templateFileKey,
      note: `Template "${templateName}" ready — open link to duplicate`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

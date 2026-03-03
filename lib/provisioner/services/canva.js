/**
 * Canva provisioning — create a project folder in Canva.
 * Uses native fetch. Receives env for credentials.
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { getCanvaToken } from "./canva-auth.js";
import { fetchT } from "./fetch-timeout.js";

/**
 * Provision a Canva folder for the project.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function provisionCanva(env, projectName, clientName) {
  const service = "Canva";

  try {
    const token = await getCanvaToken(env);
    const parentFolderId = env.CANVA_ROOT_FOLDER_ID;

    if (!parentFolderId) {
      throw new Error("Missing CANVA_ROOT_FOLDER_ID");
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const data = await withRetry(
      async () => {
        const res = await fetchT("https://api.canva.com/rest/v1/folders", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: `${clientName} \u2014 ${projectName}`,
            parent_folder_id: parentFolderId,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Canva folder creation failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Canva folder creation retry #${attempt}`, { error: err.message }),
      }
    );

    const folderId = data.folder?.id ?? data.id;
    const url = `https://www.canva.com/folder/${folderId}`;
    logger.serviceResult(service, true, url);
    return { service, success: true, url, id: folderId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

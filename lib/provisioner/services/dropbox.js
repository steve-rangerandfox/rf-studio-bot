/**
 * Dropbox provisioning — copy template folder and create shared link.
 * Uses native fetch. Receives env for credentials.
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { getDropboxToken } from "./dropbox-auth.js";
import { fetchT } from "./fetch-timeout.js";

/**
 * Provision a Dropbox project folder by copying the template.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function provisionDropbox(env, projectName, clientName) {
  const service = "Dropbox";

  try {
    const templatePath = env.DROPBOX_TEMPLATE_PATH;

    if (!templatePath) {
      throw new Error("Missing DROPBOX_TEMPLATE_PATH");
    }

    // Get token via refresh flow (auto-refreshes expired tokens)
    const token = await getDropboxToken(env);

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Derive destination: place new folder in same parent directory as template
    // e.g. template = /Production/2026/26xx_Client_Project → parent = /Production/2026
    const parentDir = templatePath.substring(0, templatePath.lastIndexOf("/"));
    const toPath = `${parentDir}/${projectName}`;

    // Step 1: Copy template folder
    await withRetry(
      async () => {
        const res = await fetchT("https://api.dropboxapi.com/2/files/copy_v2", {
          method: "POST",
          headers,
          body: JSON.stringify({ from_path: templatePath, to_path: toPath }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Dropbox copy_v2 failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Dropbox copy_v2 retry #${attempt}`, { error: err.message }),
      }
    );

    // Step 2: Create shared link
    const linkData = await withRetry(
      async () => {
        const res = await fetchT(
          "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              path: toPath,
              settings: { requested_visibility: "team_only" },
            }),
          }
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Dropbox shared link failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Dropbox shared link retry #${attempt}`, { error: err.message }),
      }
    );

    const url = linkData.url;
    logger.serviceResult(service, true, url);
    return { service, success: true, url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

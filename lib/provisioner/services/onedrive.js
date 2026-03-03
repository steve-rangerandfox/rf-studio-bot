/**
 * OneDrive provisioning — create project folder with subfolders via Microsoft Graph.
 * Uses native fetch. Receives env for credentials.
 */

import { getGraphToken } from "./graph-auth.js";
import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { fetchT } from "./fetch-timeout.js";
import { FOLDER_STRUCTURE } from "./folder-structure.js";

/**
 * Provision a OneDrive project folder with nested subfolders.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function provisionOneDrive(env, projectName, clientName) {
  const service = "OneDrive";

  try {
    const driveId = env.ONEDRIVE_DRIVE_ID;
    const rootFolderId = env.ONEDRIVE_ROOT_FOLDER_ID;
    const rootFolderPath = env.ONEDRIVE_ROOT_FOLDER_PATH; // e.g. "Production/2026"

    if (!driveId || (!rootFolderId && !rootFolderPath)) {
      throw new Error("Missing ONEDRIVE_DRIVE_ID or ONEDRIVE_ROOT_FOLDER_ID/ONEDRIVE_ROOT_FOLDER_PATH");
    }

    const token = await getGraphToken(env);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const graphBase = `https://graph.microsoft.com/v1.0/drives/${driveId}`;

    // Step 1: Create root project folder
    // Use path-based approach (more reliable for SharePoint drives) with item-ID fallback
    const rootData = await withRetry(
      async () => {
        // Try path-based URL first (preferred for SharePoint document libraries)
        const pathUrl = rootFolderPath
          ? `${graphBase}/root:/${rootFolderPath}:/children`
          : null;
        const itemUrl = rootFolderId
          ? `${graphBase}/items/${rootFolderId}/children`
          : null;

        const body = JSON.stringify({
          name: `${clientName} - ${projectName}`,
          folder: {},
          "@microsoft.graph.conflictBehavior": "rename",
        });

        // Try path-based first, fall back to item-ID
        const urlsToTry = [pathUrl, itemUrl].filter(Boolean);
        let lastError;

        for (const url of urlsToTry) {
          const res = await fetchT(url, { method: "POST", headers, body });
          if (res.ok) return res.json();
          const text = await res.text();
          lastError = `OneDrive root folder failed (${res.status}): ${text}`;
          // Only retry next approach on 404/400
          if (res.status !== 404 && res.status !== 400) {
            throw new Error(lastError);
          }
          logger.warn(`OneDrive approach failed, trying next`, { url, status: res.status });
        }
        throw new Error(lastError);
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`OneDrive root folder retry #${attempt}`, { error: err.message }),
      }
    );

    const projectFolderId = rootData.id;
    const webUrl = rootData.webUrl;

    // Step 2: Create subfolders sequentially, with children in parallel
    const folders = FOLDER_STRUCTURE.onedrive;

    for (const folder of folders) {
      const subData = await withRetry(
        async () => {
          const res = await fetchT(`${graphBase}/items/${projectFolderId}/children`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: folder.name,
              folder: {},
              "@microsoft.graph.conflictBehavior": "rename",
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`OneDrive folder "${folder.name}" failed (${res.status}): ${text}`);
          }
          return res.json();
        },
        {
          onRetry: (err, attempt) =>
            logger.warn(`OneDrive folder "${folder.name}" retry #${attempt}`, {
              error: err.message,
            }),
        }
      );

      const subFolderId = subData.id;

      if (folder.children && folder.children.length > 0) {
        await Promise.all(
          folder.children.map((childName) =>
            withRetry(
              async () => {
                const res = await fetchT(`${graphBase}/items/${subFolderId}/children`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    name: childName,
                    folder: {},
                    "@microsoft.graph.conflictBehavior": "rename",
                  }),
                });
                if (!res.ok) {
                  const text = await res.text();
                  throw new Error(`OneDrive child "${childName}" failed (${res.status}): ${text}`);
                }
                return res.json();
              },
              {
                onRetry: (err, attempt) =>
                  logger.warn(`OneDrive child "${childName}" retry #${attempt}`, {
                    error: err.message,
                  }),
              }
            )
          )
        );
      }
    }

    logger.serviceResult(service, true, webUrl);
    return { service, success: true, url: webUrl, id: projectFolderId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

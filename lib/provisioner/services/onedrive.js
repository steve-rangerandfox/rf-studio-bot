/**
 * OneDrive provisioning — create project folder with subfolders via Microsoft Graph.
 * Uses native fetch. Receives env for credentials.
 */

import { getGraphToken } from "./graph-auth.js";
import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
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

    if (!driveId || !rootFolderId) {
      throw new Error("Missing ONEDRIVE_DRIVE_ID or ONEDRIVE_ROOT_FOLDER_ID");
    }

    const token = await getGraphToken(env);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const graphBase = `https://graph.microsoft.com/v1.0/drives/${driveId}`;

    // Step 1: Create root project folder
    const rootData = await withRetry(
      async () => {
        const res = await fetch(`${graphBase}/items/${rootFolderId}/children`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: `${clientName} - ${projectName}`,
            folder: {},
            "@microsoft.graph.conflictBehavior": "rename",
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`OneDrive root folder failed (${res.status}): ${text}`);
        }
        return res.json();
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
          const res = await fetch(`${graphBase}/items/${projectFolderId}/children`, {
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
                const res = await fetch(`${graphBase}/items/${subFolderId}/children`, {
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

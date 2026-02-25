/**
 * Clockify provisioning — create project and tasks.
 * Uses native fetch. Receives env for credentials.
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { FOLDER_STRUCTURE } from "./folder-structure.js";

/**
 * Provision a Clockify project with standard tasks.
 * @param {object} env - Cloudflare env bindings
 * @param {string} projectName
 * @param {string} clientName
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function provisionClockify(env, projectName, clientName) {
  const service = "Clockify";

  try {
    const apiKey = env.CLOCKIFY_API_KEY;
    const workspaceId = env.CLOCKIFY_WORKSPACE_ID;

    if (!apiKey || !workspaceId) {
      throw new Error("Missing CLOCKIFY_API_KEY or CLOCKIFY_WORKSPACE_ID");
    }

    const headers = {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    };

    const baseUrl = `https://api.clockify.me/api/v1/workspaces/${workspaceId}`;

    // Step 1: Create project
    const projectData = await withRetry(
      async () => {
        const res = await fetch(`${baseUrl}/projects`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: `${projectName} \u2014 ${clientName}`,
            color: "#4A90E2",
            billable: true,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Clockify create project failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Clockify create project retry #${attempt}`, { error: err.message }),
      }
    );

    const projectId = projectData.id;

    // Step 2: Create tasks in parallel
    const tasks = FOLDER_STRUCTURE.clockifyTasks;

    await Promise.all(
      tasks.map((taskName) =>
        withRetry(
          async () => {
            const res = await fetch(`${baseUrl}/projects/${projectId}/tasks`, {
              method: "POST",
              headers,
              body: JSON.stringify({ name: taskName }),
            });
            if (!res.ok) {
              const text = await res.text();
              throw new Error(`Clockify task "${taskName}" failed (${res.status}): ${text}`);
            }
            return res.json();
          },
          {
            onRetry: (err, attempt) =>
              logger.warn(`Clockify task "${taskName}" retry #${attempt}`, {
                error: err.message,
              }),
          }
        )
      )
    );

    const url = `https://app.clockify.me/workspaces/${workspaceId}/projects/${projectId}/edit`;
    logger.serviceResult(service, true, url);
    return { service, success: true, url, id: projectId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

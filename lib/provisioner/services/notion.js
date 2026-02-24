/**
 * Notion provisioning — create a project page in the database and patch with links.
 * Uses native fetch. Receives env for credentials.
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";

const NOTION_API = "https://api.notion.com/v1";

function getHeaders(env) {
  const token = env.NOTION_TOKEN;
  if (!token) throw new Error("Missing NOTION_TOKEN");
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

/**
 * Create a Notion page in the projects database.
 * @param {object} env - Cloudflare env bindings
 * @param {object} form - Project intake form data
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function createNotionPage(env, form) {
  const service = "Notion";

  try {
    const databaseId = env.NOTION_PROJECTS_DB_ID;
    if (!databaseId) throw new Error("Missing NOTION_PROJECTS_DB_ID");

    const headers = getHeaders(env);

    const properties = {
      Name: {
        title: [{ text: { content: `${form.projectName} \u2014 ${form.clientName}` } }],
      },
      "Project Type": {
        select: { name: form.projectType },
      },
      Status: {
        select: { name: "Active" },
      },
      "Project Manager": {
        rich_text: [{ text: { content: form.projectManager } }],
      },
    };

    if (form.startDate) {
      properties["Start Date"] = { date: { start: form.startDate } };
    }

    if (form.deadline) {
      properties["Deadline"] = { date: { start: form.deadline } };
    }

    if (form.description) {
      properties["Description"] = {
        rich_text: [{ text: { content: form.description } }],
      };
    }

    const data = await withRetry(
      async () => {
        const res = await fetch(`${NOTION_API}/pages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Notion create page failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Notion create page retry #${attempt}`, { error: err.message }),
      }
    );

    const pageId = data.id;
    const url = data.url;
    logger.serviceResult(service, true, url);
    return { service, success: true, url, id: pageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

/**
 * Patch an existing Notion page with links to other provisioned services.
 * @param {object} env - Cloudflare env bindings
 * @param {string} pageId - Notion page ID
 * @param {object} links - { dropboxUrl, frameioUrl, teamsUrl, canvaUrl, onedriveUrl, clockifyUrl, figjamUrl }
 */
export async function patchNotionPageWithLinks(env, pageId, links) {
  try {
    const headers = getHeaders(env);

    const properties = {};

    if (links.dropboxUrl) {
      properties["Dropbox"] = { url: links.dropboxUrl };
    }
    if (links.frameioUrl) {
      properties["Frame.io"] = { url: links.frameioUrl };
    }
    if (links.teamsUrl) {
      properties["Teams Chat"] = { url: links.teamsUrl };
    }
    if (links.canvaUrl) {
      properties["Canva"] = { url: links.canvaUrl };
    }
    if (links.onedriveUrl) {
      properties["OneDrive"] = { url: links.onedriveUrl };
    }
    if (links.clockifyUrl) {
      properties["Clockify"] = { url: links.clockifyUrl };
    }
    if (links.figjamUrl) {
      properties["FigJam"] = { url: links.figjamUrl };
    }

    if (Object.keys(properties).length === 0) {
      logger.info("No links to patch on Notion page");
      return;
    }

    await withRetry(
      async () => {
        const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ properties }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Notion patch links failed (${res.status}): ${text}`);
        }
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Notion patch links retry #${attempt}`, { error: err.message }),
      }
    );

    logger.info("Notion page patched with links", { pageId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to patch Notion page with links: ${message}`);
  }
}

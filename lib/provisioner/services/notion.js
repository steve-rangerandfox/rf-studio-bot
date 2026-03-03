/**
 * Notion provisioning — create a project page in the database and patch with links.
 * Uses native fetch. Receives env for credentials.
 *
 * Queries the database schema first so we only set properties that actually
 * exist, avoiding "property not found" errors on partially-configured DBs.
 */

import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { fetchT } from "./fetch-timeout.js";

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
 * Fetch the database schema and return a Set of property names.
 */
async function getDbProperties(headers, databaseId) {
  const res = await fetchT(`${NOTION_API}/databases/${databaseId}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion get database failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return new Map(
    Object.entries(data.properties || {}).map(([name, prop]) => [name, prop.type])
  );
}

/**
 * Safely set a property only if it exists in the schema with the expected type.
 */
function setIfExists(properties, schema, name, type, value) {
  if (schema.has(name) && schema.get(name) === type) {
    properties[name] = value;
  }
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

    // Query DB schema so we only set properties that exist
    const schema = await getDbProperties(headers, databaseId);

    // Find the title property (every DB has exactly one)
    let titlePropName = "Name";
    for (const [name, type] of schema) {
      if (type === "title") { titlePropName = name; break; }
    }

    const properties = {
      [titlePropName]: {
        title: [{ text: { content: `${form.projectName} \u2014 ${form.clientName}` } }],
      },
    };

    setIfExists(properties, schema, "Project Type", "select",
      { select: { name: form.projectType } });
    setIfExists(properties, schema, "Status", "select",
      { select: { name: "Active" } });
    setIfExists(properties, schema, "Project Manager", "rich_text",
      { rich_text: [{ text: { content: form.projectManager } }] });

    if (form.startDate) {
      setIfExists(properties, schema, "Start Date", "date",
        { date: { start: form.startDate } });
    }
    if (form.deadline) {
      setIfExists(properties, schema, "Deadline", "date",
        { date: { start: form.deadline } });
    }
    if (form.description) {
      setIfExists(properties, schema, "Description", "rich_text",
        { rich_text: [{ text: { content: form.description } }] });
    }

    const data = await withRetry(
      async () => {
        const res = await fetchT(`${NOTION_API}/pages`, {
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
 * Only sets link properties that exist in the database schema.
 * @param {object} env - Cloudflare env bindings
 * @param {string} pageId - Notion page ID
 * @param {object} links - { dropboxUrl, frameioUrl, teamsUrl, canvaUrl, onedriveUrl, clockifyUrl, figjamUrl }
 */
export async function patchNotionPageWithLinks(env, pageId, links) {
  try {
    const headers = getHeaders(env);
    const databaseId = env.NOTION_PROJECTS_DB_ID;

    // Get schema so we only patch properties that exist
    let schema;
    try {
      schema = await getDbProperties(headers, databaseId);
    } catch (_) {
      // If we can't read the schema, try patching anyway
      schema = null;
    }

    const linkMap = {
      Dropbox: links.dropboxUrl,
      "Frame.io": links.frameioUrl,
      "Teams Chat": links.teamsUrl,
      Canva: links.canvaUrl,
      OneDrive: links.onedriveUrl,
      Clockify: links.clockifyUrl,
      FigJam: links.figjamUrl,
    };

    const properties = {};
    for (const [name, url] of Object.entries(linkMap)) {
      if (!url) continue;
      // If we have the schema, only set url-type properties that exist
      if (schema && (!schema.has(name) || schema.get(name) !== "url")) continue;
      properties[name] = { url };
    }

    if (Object.keys(properties).length === 0) {
      logger.info("No matching link properties to patch on Notion page");
      return;
    }

    await withRetry(
      async () => {
        const res = await fetchT(`${NOTION_API}/pages/${pageId}`, {
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

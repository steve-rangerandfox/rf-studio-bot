/**
 * Teams Chat provisioning — create a group chat via Microsoft Graph.
 * Uses native fetch. Receives env for credentials.
 */

import { getGraphToken } from "./graph-auth.js";
import { withRetry } from "./retry.js";
import { logger } from "./logger.js";
import { fetchT } from "./fetch-timeout.js";

const GRAPH_API = "https://graph.microsoft.com/v1.0";

async function resolveUserId(email, token) {
  const res = await fetchT(
    `${GRAPH_API}/users/${encodeURIComponent(email)}?$select=id`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403) {
      // Log the token's app ID for debugging (extracted from JWT payload)
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        console.error(`[teams-chat] 403 resolving user. Token appid=${payload.appid || payload.azp}, roles=${JSON.stringify(payload.roles || [])}`);
      } catch (_) {}
      throw new Error(
        `Permission denied resolving user "${email}". ` +
        `Ensure the Azure AD app used for Graph auth has User.Read.All (Application) permission with admin consent. ` +
        `Check that AZURE_CLIENT_ID matches the app where permissions were granted. Response: ${text.slice(0, 200)}`
      );
    }
    throw new Error(`Failed to resolve user "${email}" (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.id;
}

/**
 * Provision a Teams group chat for the project.
 * @param {object} env - Cloudflare env bindings
 * @param {object} form - Project intake form data
 * @returns {Promise<{service: string, success: boolean, url?: string, id?: string, error?: string}>}
 */
export async function provisionTeamsChat(env, form) {
  const service = "Teams";

  try {
    const token = await getGraphToken(env);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Step 1: Resolve all email addresses to user IDs
    const allEmails = [form.projectManager, ...form.teamMembers].filter(Boolean);
    const uniqueEmails = [...new Set(allEmails)];

    const memberPromises = uniqueEmails.map(async (email) => {
      const userId = await withRetry(() => resolveUserId(email, token), {
        onRetry: (err, attempt) =>
          logger.warn(`Teams resolve user "${email}" retry #${attempt}`, {
            error: err.message,
          }),
      });
      return {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        "user@odata.bind": `${GRAPH_API}/users('${userId}')`,
        roles: ["owner"],
      };
    });

    const members = await Promise.all(memberPromises);

    // Step 2: Create group chat
    const chatData = await withRetry(
      async () => {
        const res = await fetchT(`${GRAPH_API}/chats`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            chatType: "group",
            topic: `${form.projectName} \u2014 ${form.clientName}`,
            members,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Teams create chat failed (${res.status}): ${text}`);
        }
        return res.json();
      },
      {
        onRetry: (err, attempt) =>
          logger.warn(`Teams create chat retry #${attempt}`, { error: err.message }),
      }
    );

    const chatId = chatData.id;

    // Step 3: Post welcome message (non-fatal — chat is still usable without it)
    const welcomeHtml = `
      <h2>\ud83c\udfac Project Kickoff: ${form.projectName}</h2>
      <p><strong>Client:</strong> ${form.clientName}</p>
      <p><strong>Type:</strong> ${form.projectType}</p>
      <p><strong>Project Manager:</strong> ${form.projectManager}</p>
      ${form.description ? `<p><strong>Brief:</strong> ${form.description}</p>` : ""}
      <p><em>This chat was auto-provisioned by the New Project Provisioner bot.</em></p>
    `.trim();

    try {
      await withRetry(
        async () => {
          const res = await fetchT(`${GRAPH_API}/chats/${chatId}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              body: { contentType: "html", content: welcomeHtml },
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`Teams send welcome message failed (${res.status}): ${text}`);
          }
        },
        {
          onRetry: (err, attempt) =>
            logger.warn(`Teams send welcome message retry #${attempt}`, {
              error: err.message,
            }),
        }
      );
    } catch (msgErr) {
      // Welcome message failed but the chat was created — still count as success
      logger.warn(`Teams welcome message failed (non-fatal): ${msgErr.message}`);
    }

    const encodedChatId = encodeURIComponent(chatId);
    const url = `https://teams.microsoft.com/l/chat/${encodedChatId}`;
    const note = "Chat created (welcome message requires additional permissions)";
    logger.serviceResult(service, true, url);
    return { service, success: true, url, id: chatId, note };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.serviceResult(service, false, message);
    return { service, success: false, error: message };
  }
}

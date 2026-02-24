/**
 * Bot Framework REST API v3 — send messages and Adaptive Cards to Teams.
 */

import { getAccessToken } from './auth.js';

/**
 * Send an Adaptive Card to a Teams conversation.
 * @param {object} env           Cloudflare env
 * @param {string} serviceUrl    Bot Framework service URL (includes trailing slash)
 * @param {string} conversationId
 * @param {object} card          Adaptive Card JSON
 * @returns {Promise<Response>}
 */
export async function sendCard(env, serviceUrl, conversationId, card) {
  const token = await getAccessToken(env);
  const url = `${serviceUrl}v3/conversations/${conversationId}/activities`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: card,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[send] sendCard failed (${res.status}):`, body);
  }

  return res;
}

/**
 * Send a plain text message to a Teams conversation.
 * @param {object} env
 * @param {string} serviceUrl
 * @param {string} conversationId
 * @param {string} text
 * @returns {Promise<Response>}
 */
export async function sendText(env, serviceUrl, conversationId, text) {
  const token = await getAccessToken(env);
  const url = `${serviceUrl}v3/conversations/${conversationId}/activities`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'message',
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[send] sendText failed (${res.status}):`, body);
  }

  return res;
}

/**
 * Update an existing message/card in a Teams conversation.
 * @param {object} env
 * @param {string} serviceUrl
 * @param {string} conversationId
 * @param {string} activityId       The activity ID of the message to update
 * @param {object} card             Replacement Adaptive Card JSON
 * @returns {Promise<Response>}
 */
export async function updateCard(env, serviceUrl, conversationId, activityId, card) {
  const token = await getAccessToken(env);
  const url = `${serviceUrl}v3/conversations/${conversationId}/activities/${activityId}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'message',
      id: activityId,
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: card,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[send] updateCard failed (${res.status}):`, body);
  }

  return res;
}

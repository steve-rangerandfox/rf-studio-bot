/**
 * Conversation state manager — stores per-conversation state in KV.
 * State auto-expires after 1 hour if the user abandons mid-flow.
 *
 * Each state object includes a `feature` field to route messages
 * to the correct handler: 'deck' | 'provisioner' | 'storyboard'.
 */

const STATE_PREFIX = 'bot_state_';
const STATE_TTL = 3600; // 1 hour in seconds

/**
 * Get conversation state from KV.
 * @param {object} env             Cloudflare env with RF_STORE binding
 * @param {string} conversationId
 * @returns {Promise<object|null>}  State object or null if not found / expired
 */
export async function getState(env, conversationId) {
  if (!env.RF_STORE) return null;

  const key = `${STATE_PREFIX}${conversationId}`;
  const raw = await env.RF_STORE.get(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save conversation state to KV with 1-hour TTL.
 * Automatically stamps `updatedAt` on every write.
 *
 * @param {object} env
 * @param {string} conversationId
 * @param {object} state  Must include `feature`: 'deck' | 'provisioner' | 'storyboard'
 */
export async function setState(env, conversationId, state) {
  if (!env.RF_STORE) return;

  const key = `${STATE_PREFIX}${conversationId}`;
  await env.RF_STORE.put(
    key,
    JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString(),
    }),
    { expirationTtl: STATE_TTL },
  );
}

/**
 * Delete conversation state from KV.
 * @param {object} env
 * @param {string} conversationId
 */
export async function clearState(env, conversationId) {
  if (!env.RF_STORE) return;

  const key = `${STATE_PREFIX}${conversationId}`;
  await env.RF_STORE.delete(key);
}

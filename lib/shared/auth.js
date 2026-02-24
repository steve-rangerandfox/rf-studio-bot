/**
 * Bot Framework JWT validation and token acquisition.
 * Uses Web Crypto API — runs on Cloudflare Workers without Node.js crypto.
 *
 * Supports SingleTenant bot registration with org tenant:
 *   439235f0-c680-4a15-a7bd-2f766e97c5fe
 */

const TENANT_ID = '439235f0-c680-4a15-a7bd-2f766e97c5fe';
const OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const TOKEN_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token';
const JWKS_CACHE_KEY = 'bot_jwks';
const JWKS_CACHE_TTL = 86400; // 24 hours
const TOKEN_CACHE_KEY = 'bot_access_token';

/**
 * Validate an incoming JWT from the Bot Framework.
 * @param {string} authHeader  Full Authorization header ("Bearer <token>")
 * @param {string} expectedAppId  The bot's Microsoft App ID
 * @param {object} env  Cloudflare env with RF_STORE binding
 * @returns {Promise<boolean>}
 */
export async function validateBotToken(authHeader, expectedAppId, env) {
  // Skip validation in dev mode
  if (env.BOT_DEV_MODE === 'true') return true;

  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);

  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return false;

    const header = JSON.parse(b64UrlDecode(headerB64));
    const payload = JSON.parse(b64UrlDecode(payloadB64));

    // ── Audience check ──
    if (payload.aud !== expectedAppId) return false;

    // ── Issuer check — allow Bot Framework + org-tenant issuers ──
    const validIssuers = [
      'https://api.botframework.com',
      'https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/',
      'https://login.microsoftonline.com/d6d49420-f39b-4df7-a1dc-d59a935871db/v2.0',
      'https://sts.windows.net/f8cdef31-a31e-4b4a-93e4-5f571e91255a/',
      'https://login.microsoftonline.com/f8cdef31-a31e-4b4a-93e4-5f571e91255a/v2.0',
      // Org tenant (SingleTenant bot)
      `https://sts.windows.net/${TENANT_ID}/`,
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    ];

    const issuerValid = validIssuers.some(
      (iss) => payload.iss === iss || payload.iss?.startsWith(iss.replace('/v2.0', ''))
    );
    if (!issuerValid) return false;

    // ── Expiration check ──
    if (payload.exp * 1000 < Date.now()) return false;

    // ── Signature verification ──
    const jwks = await getJwks(env);
    const jwk = jwks.find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = b64UrlToBuffer(signatureB64);

    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, data);
  } catch (err) {
    console.error('[auth] JWT validation error:', err);
    return false;
  }
}

/**
 * Acquire an access token for sending messages back to the Bot Framework.
 * Caches the token in KV with automatic expiration.
 * @param {object} env  Cloudflare env with RF_STORE, TEAMS_APP_ID, TEAMS_APP_SECRET
 * @returns {Promise<string>}
 */
export async function getAccessToken(env) {
  // ── Check KV cache ──
  if (env.RF_STORE) {
    try {
      const cached = await env.RF_STORE.get(TOKEN_CACHE_KEY);
      if (cached) {
        const data = JSON.parse(cached);
        // Return cached token if it has >1 min remaining
        if (data.expiresAt > Date.now() + 60_000) {
          return data.token;
        }
      }
    } catch (_) {
      // KV read failure — fall through to fetch
    }
  }

  // ── Fetch fresh token ──
  const tenantId = env.TEAMS_TENANT_ID || TENANT_ID;
  const tokenUrl = TOKEN_URL_TEMPLATE.replace('{tenantId}', tenantId);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TEAMS_APP_ID,
    client_secret: env.TEAMS_APP_SECRET,
    scope: 'https://api.botframework.com/.default',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token acquisition failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

  // ── Cache in KV ──
  if (env.RF_STORE) {
    try {
      await env.RF_STORE.put(
        TOKEN_CACHE_KEY,
        JSON.stringify({ token, expiresAt }),
        { expirationTtl: data.expires_in },
      );
    } catch (_) {
      // KV write failure — non-fatal, token still usable
    }
  }

  return token;
}

// ── Internal helpers ──────────────────────────────────────────────

/**
 * Fetch and cache the Bot Framework JWKS keys.
 */
async function getJwks(env) {
  // Check KV cache
  if (env.RF_STORE) {
    try {
      const cached = await env.RF_STORE.get(JWKS_CACHE_KEY);
      if (cached) {
        const data = JSON.parse(cached);
        if (data.fetchedAt && Date.now() - data.fetchedAt < JWKS_CACHE_TTL * 1000) {
          return data.keys;
        }
      }
    } catch (_) {
      // KV read failure — fall through to fetch
    }
  }

  // Fetch OpenID configuration
  const openIdRes = await fetch(OPENID_URL);
  if (!openIdRes.ok) throw new Error(`OpenID config fetch failed: ${openIdRes.status}`);
  const openIdConfig = await openIdRes.json();

  // Fetch JWKS
  const jwksRes = await fetch(openIdConfig.jwks_uri);
  if (!jwksRes.ok) throw new Error(`JWKS fetch failed: ${jwksRes.status}`);
  const jwksData = await jwksRes.json();
  const keys = jwksData.keys || [];

  // Cache in KV
  if (env.RF_STORE) {
    try {
      await env.RF_STORE.put(
        JWKS_CACHE_KEY,
        JSON.stringify({ keys, fetchedAt: Date.now() }),
        { expirationTtl: JWKS_CACHE_TTL },
      );
    } catch (_) {
      // KV write failure — non-fatal
    }
  }

  return keys;
}

/**
 * Decode a Base64-URL string to a UTF-8 string.
 */
function b64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const final = pad ? padded + '='.repeat(4 - pad) : padded;
  return atob(final);
}

/**
 * Decode a Base64-URL string to an ArrayBuffer.
 */
function b64UrlToBuffer(str) {
  const binary = b64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

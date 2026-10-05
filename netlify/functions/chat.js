/* ==========================================================
   DRISS DIGITALS chatbot – secure Netlify Function (Phase 4)
   POST /.netlify/functions/chat
   Header: Authorization: Bearer <Supabase access token>
   Body:   { "message": "...", "conversation_id": "uuid" | null }
   Reply:  { "reply": "..." }

   Order of checks:
     OPTIONS -> 204 | not POST -> 405 | no Bearer token -> 401
     bad body -> 400/413 | token not verified by Supabase -> 401
     rate limit -> 429 | conversation not owned -> 403 | else 200

   Environment variables (Netlify dashboard only, never in code):
     SUPABASE_URL                 required
     SUPABASE_SERVICE_ROLE_KEY    required (server-side secret)
     ALLOWED_ORIGIN               optional (CORS)
     OPENAI_API_KEY               NOT used yet (future LLM step)
   ========================================================== */

'use strict';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_BODY_BYTES = 20000;
const MAX_TOKEN_LENGTH = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  };
}

/* ----------------------------------------------------------
   BASIC RATE LIMIT (in-memory, per user)
   Fixed window: RATE_LIMIT_MAX requests per user per window.
   LIMITATION: Netlify Functions are serverless. Memory is not shared
   between instances and resets on cold start, so this only blocks
   simple floods. It is NOT a production-grade distributed limiter.
   Before the paid LLM goes live, add a shared limiter (for example a
   Supabase table or a Redis/Upstash counter) and a spending cap.
   ---------------------------------------------------------- */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map(); // userId -> { start, count }

// Returns 0 if allowed, otherwise the seconds to wait.
function checkRateLimit(userId) {
  const now = Date.now();

  if (rateBuckets.size > 5000) { // keep memory bounded
    for (const [key, b] of rateBuckets) {
      if (now - b.start >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
    }
    if (rateBuckets.size > 5000) rateBuckets.clear();
  }

  let bucket = rateBuckets.get(userId);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(userId, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((bucket.start + RATE_LIMIT_WINDOW_MS - now) / 1000));
  }
  return 0;
}

/* ----------------------------------------------------------
   SUPABASE (server-side only)
   The service-role client bypasses RLS, so it is used ONLY here,
   for (1) verifying the visitor's token and (2) the ownership check.
   ---------------------------------------------------------- */
let adminClient = null;
function getAdminClient() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable');
  }
  const { createClient } = require('@supabase/supabase-js');
  adminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return adminClient;
}

function getBearerToken(event) {
  const headers = event.headers || {};
  let value = '';
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'authorization') { value = String(headers[name] || ''); break; }
  }
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return null;
  return match[1];
}

// Asks Supabase Auth to validate the token (signature, expiry, user exists).
// We never decode the JWT ourselves. Returns the user id, or null if invalid.
async function verifyAccessToken(token) {
  const { data, error } = await getAdminClient().auth.getUser(token);
  if (error) {
    const status = error.status;
    if (error.name === 'AuthRetryableFetchError' || (typeof status === 'number' && status >= 500)) {
      throw error; // Supabase unreachable/broken: a server problem, not a bad token
    }
    return null;
  }
  return data && data.user ? data.user.id : null;
}

// true only if the conversation exists AND belongs to this user.
async function userOwnsConversation(userId, conversationId) {
  const { data, error } = await getAdminClient()
    .from('chat_conversations')
    .select('user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw error;
  return !!data && data.user_id === userId;
}

/* ----------------------------------------------------------
   getAssistantReply(message, conversationId, userId)
   TEMPORARY: returns a fixed test reply.

   LATER: call the OpenAI Responses API here using
   process.env.OPENAI_API_KEY, and save the assistant message to
   Supabase server-side (service-role client) before returning.
   ---------------------------------------------------------- */
async function getAssistantReply(message, conversationId, userId) {
  return 'This is a response from the secure Netlify function.';
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed. Use POST.' }, { Allow: 'POST, OPTIONS' });
    }

    // 1. A Bearer token must be present (verified with Supabase below)
    const token = getBearerToken(event);
    if (!token) {
      return json(401, { error: 'Authentication required.' }, { 'WWW-Authenticate': 'Bearer' });
    }

    // 2. Body size + JSON + field validation (no network calls yet)
    let raw = event.body || '';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return json(413, { error: 'Request too large.' });
    }

    let payload;
    try { payload = JSON.parse(raw); }
    catch { return json(400, { error: 'Invalid JSON.' }); }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(400, { error: 'Request body must be a JSON object.' });
    }

    if (typeof payload.message !== 'string') {
      return json(400, { error: '"message" must be a string.' });
    }
    const message = payload.message.trim();
    if (!message) return json(400, { error: '"message" cannot be empty.' });
    if (message.length > MAX_MESSAGE_LENGTH) {
      return json(400, { error: `"message" is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
    }

    // conversation_id is optional for now (null allowed). Tighten later.
    let conversationId = null;
    if (payload.conversation_id !== undefined && payload.conversation_id !== null) {
      if (typeof payload.conversation_id !== 'string' || !UUID_RE.test(payload.conversation_id)) {
        return json(400, { error: '"conversation_id" must be a valid UUID.' });
      }
      conversationId = payload.conversation_id;
    }

    // 3. Verify the token with Supabase Auth
    const userId = await verifyAccessToken(token);
    if (!userId) {
      return json(401, { error: 'Invalid or expired session.' }, { 'WWW-Authenticate': 'Bearer' });
    }

    // 4. Rate limit (per verified user)
    const retryAfter = checkRateLimit(userId);
    if (retryAfter) {
      return json(429, { error: 'Too many messages. Please wait a moment.' }, { 'Retry-After': String(retryAfter) });
    }

    // 5. Conversation ownership (same 403 whether it is missing or someone else's)
    if (conversationId && !(await userOwnsConversation(userId, conversationId))) {
      return json(403, { error: 'You do not have access to this conversation.' });
    }

    const reply = await getAssistantReply(message, conversationId, userId);
    return json(200, { reply });
  } catch (err) {
    // Details stay in Netlify's function logs only, never in the response.
    console.error('chat function error:', err && err.message ? err.message : err);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
};

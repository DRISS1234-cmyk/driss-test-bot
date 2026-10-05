/* ==========================================================
   DRISS DIGITALS chatbot – secure Netlify Function
   POST /.netlify/functions/chat
   Body:  { "message": "I need a website", "conversation_id": "uuid" }
   Reply: { "reply": "..." }

   No API key is required yet. The future LLM key is read ONLY
   from a Netlify environment variable (process.env.OPENAI_API_KEY)
   and never appears in browser code.
   ========================================================== */

'use strict';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_BODY_BYTES = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Optional: set ALLOWED_ORIGIN in Netlify (e.g. https://driss.com.ng) to
// restrict browser access. Defaults to "*" while there is no paid API behind this.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

/* ----------------------------------------------------------
   getAssistantReply(message, conversationId)
   TEMPORARY: returns a fixed test reply.

   LATER: replace the body with a call to the OpenAI Responses API:
     const apiKey = process.env.OPENAI_API_KEY;   // Netlify env var
     if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
     const res = await fetch('https://api.openai.com/v1/responses', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
       body: JSON.stringify({ model: '...', input: message }),
     });
     ...return the text from the response.
   This function is also where the assistant message can be saved to
   Supabase securely (server-side) before returning.
   ---------------------------------------------------------- */
async function getAssistantReply(message, conversationId) {
  return 'This is a response from the secure Netlify function.';
}

exports.handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }

    if (event.httpMethod !== 'POST') {
      return {
        ...json(405, { error: 'Method not allowed. Use POST.' }),
        headers: { ...json(405, {}).headers, Allow: 'POST, OPTIONS' },
      };
    }

    // Read body (Netlify may base64-encode it)
    let raw = event.body || '';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return json(413, { error: 'Request too large.' });
    }

    // Parse JSON safely
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Invalid JSON.' });
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(400, { error: 'Request body must be a JSON object.' });
    }

    // Validate message
    if (typeof payload.message !== 'string') {
      return json(400, { error: '"message" must be a string.' });
    }
    const message = payload.message.trim();
    if (!message) {
      return json(400, { error: '"message" cannot be empty.' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return json(400, { error: `"message" is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
    }

    // Validate conversation_id (optional: the browser sends null if Supabase is down)
    let conversationId = null;
    if (payload.conversation_id !== undefined && payload.conversation_id !== null) {
      if (typeof payload.conversation_id !== 'string' || !UUID_RE.test(payload.conversation_id)) {
        return json(400, { error: '"conversation_id" must be a valid UUID.' });
      }
      conversationId = payload.conversation_id;
    }

    const reply = await getAssistantReply(message, conversationId);
    return json(200, { reply });
  } catch (err) {
    // Details stay in Netlify's function logs only, never in the response.
    console.error('chat function error:', err && err.message ? err.message : err);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
};

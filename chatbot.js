/* ==========================================================
   DRISS DIGITALS chatbot – standalone UI logic
   Sections:
     1. Config
     2. SUPABASE LAYER   (anonymous session, conversation, saving)
     3. ASSISTANT LAYER  (Netlify Function call + local fallback)
     4. UI LAYER         (messages, typing, open/close, events)
   ========================================================== */
(function () {
  'use strict';

  /* ---------- 1. Config ---------- */
  var WELCOME_MESSAGE =
    "Hi, welcome to DRISS DIGITALS. I can answer questions about our " +
    "websites and services. What can I help you with?";

  var TYPING_DELAY_MS = 900; // fake "thinking" time; only used by the temporary responder

  // Same PUBLIC project URL + publishable key already used in index.html.
  // These are safe in the browser (access is controlled by RLS). Never put
  // a service-role / secret key here.
  var SUPABASE_URL = 'https://sqnrcgwspvmnvromfazj.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_deSnqH-5Dp9qLFZMm-wC0Q_znsD6V1x';
  var OPEN_STATUS  = 'open'; // value of chat_conversations.status for an active chat

  // Secure Netlify Function (no secrets in the browser; the future LLM key
  // lives only in Netlify environment variables).
  var ASSISTANT_ENDPOINT   = '/.netlify/functions/chat';
  var ASSISTANT_TIMEOUT_MS = 20000;


  /* ==========================================================
     2. SUPABASE LAYER
     Every function here fails soft: errors go to the console and
     the chat keeps working without saving.
     ========================================================== */

  var db = null;                  // Supabase client
  var conversationPromise = null; // cached find-or-create result (one per page)
  var saveQueue = Promise.resolve(); // keeps saves in order

  // Reuse the site's client (ddClient from index.html) when it exists, so
  // the page has ONE client. Standalone, create one with the same config.
  function getDb() {
    if (db) return db;
    try {
      if (typeof ddClient !== 'undefined' && ddClient) { db = ddClient; return db; }
    } catch (e) { /* not defined yet */ }
    if (window.supabase && window.supabase.createClient) {
      db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    return db;
  }

  // Same approach as ddEnsureSession() in index.html: reuse the saved
  // session, try a refresh, and only then create a new anonymous one.
  async function ensureUserId(client) {
    var s = await client.auth.getSession();
    if (s.data && s.data.session) return s.data.session.user.id;

    try {
      var r = await client.auth.refreshSession();
      if (!r.error && r.data && r.data.session) return r.data.session.user.id;
    } catch (e) { /* fall through */ }

    var a = await client.auth.signInAnonymously();
    if (a.error) throw a.error;
    return a.data.user.id;
  }

  async function findOrCreateConversation() {
    var client = getDb();
    if (!client) throw new Error('Supabase client not available');

    var userId = await ensureUserId(client);

    var found = await client.from('chat_conversations')
      .select('id')
      .eq('user_id', userId)
      .eq('status', OPEN_STATUS)
      .order('created_at', { ascending: false })
      .limit(1);
    if (found.error) throw found.error;
    if (found.data && found.data.length) return found.data[0].id;

    var created = await client.from('chat_conversations')
      .insert({ user_id: userId, status: OPEN_STATUS })
      .select('id')
      .single();
    if (created.error) throw created.error;
    return created.data.id;
  }

  // Resolves to a conversation id, or null if Supabase is unavailable.
  // A failure is not cached, so the next message tries again.
  function getConversationId() {
    if (!conversationPromise) {
      conversationPromise = findOrCreateConversation().catch(function (err) {
        console.warn('[chatbot] conversation setup failed:', err);
        conversationPromise = null;
        return null;
      });
    }
    return conversationPromise;
  }

  // Private: only the two wrappers below call this, with a hard-coded
  // sender. Visitor text can never choose the sender value.
  async function saveMessage(sender, text) {
    try {
      var client = getDb();
      var conversationId = await getConversationId();
      if (!client || !conversationId) return false;
      var res = await client.from('chat_messages')
        .insert({ conversation_id: conversationId, sender: sender, message: text });
      if (res.error) throw res.error;
      return true;
    } catch (err) {
      console.warn('[chatbot] could not save ' + sender + ' message:', err);
      return false;
    }
  }

  function queueSave(sender, text) {
    saveQueue = saveQueue.then(function () { return saveMessage(sender, text); });
    return saveQueue;
  }
  function saveUserMessage(text) { return queueSave('user', text); }
  // No saveAssistantMessage() on purpose: assistant rows must only be
  // created server-side (see note in handleSend).


  /* ==========================================================
     3. ASSISTANT LAYER
     ----------------------------------------------------------
     The UI only ever calls sendMessageToAssistant(message).
     It asks the secure Netlify Function for a reply and, if that
     fails for any reason, falls back to the local TEMPORARY
     responder below so the chat never breaks.
     NO API keys belong in this file.
     ========================================================== */

  // Waits briefly for the conversation id; null if Supabase is slow/down.
  function conversationIdOrNull() {
    return Promise.race([
      getConversationId(),
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 3000); })
    ]);
  }

  // Calls the Netlify Function. Resolves to a reply string or throws.
  async function requestAssistantResponse(message, conversationId) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ASSISTANT_TIMEOUT_MS);
    try {
      var res = await fetch(ASSISTANT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message, conversation_id: conversationId }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error('Function returned HTTP ' + res.status);
      var data = await res.json();
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) {
        throw new Error('Function returned no reply');
      }
      return data.reply;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendMessageToAssistant(message) {
    try {
      var conversationId = await conversationIdOrNull();
      return await requestAssistantResponse(message, conversationId);
    } catch (err) {
      console.warn('[chatbot] Netlify function unavailable, using local fallback:', err);
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(getTemporaryResponse(message)); // TEMPORARY local fallback
        }, TYPING_DELAY_MS);
      });
    }
  }

  /* ----------------------------------------------------------
     TEMPORARY RESPONSE SYSTEM  (delete when the real AI is live)
     Simple keyword matching. Order matters: pricing is checked
     before "website" so "How much does a website cost?" gets the
     pricing answer.
     ---------------------------------------------------------- */
  function getTemporaryResponse(message) {
    var text = message.toLowerCase();

    if (/\b(price|prices|pricing|cost|costs|quote|budget|how much)\b/.test(text)) {
      return "Pricing depends on the project: the number of pages, the features you need, and any custom work. " +
             "I can collect a few details about your project so the team can give you an accurate quote. " +
             "What kind of website do you have in mind?";
    }

    if (/\b(ecommerce|e-commerce|store|shop|sell online|selling|checkout)\b/.test(text)) {
      return "Yes, we can build online stores. That includes product pages, a cart and checkout, " +
             "and a layout that works well on phones. What would you like to sell?";
    }

    if (/\b(service|services|offer|offers|do you do|what do you)\b/.test(text)) {
      return "DRISS DIGITALS offers web design, web development, and related digital solutions " +
             "for businesses. Tell me about your business and I can point you to what fits.";
    }

    if (/\b(website|web site|site|web design|web development)\b/.test(text)) {
      return "DRISS DIGITALS builds custom websites designed around your business and your customers. " +
             "What type of business is it, and what should the site help you do?";
    }

    return "Thanks for your message. What do you need help with? " +
           "I can talk about websites, online stores, services, or the cost of a project.";
  }


  /* ==========================================================
     4. UI LAYER
     ========================================================== */

  var root      = document.getElementById('ddChat');
  if (!root) return; // widget markup not on this page

  var launcher  = document.getElementById('ddLauncher');
  var closeBtn  = document.getElementById('ddClose');
  var messages  = document.getElementById('ddMessages');
  var quick     = document.getElementById('ddQuick');
  var form      = document.getElementById('ddForm');
  var input     = document.getElementById('ddInput');
  var sendBtn   = document.getElementById('ddSend');

  var isOpen = false;
  var isBusy = false;     // true while waiting for a reply
  var typingEl = null;
  var setupStarted = false;

  /* --- open / close --- */
  function openChat() {
    isOpen = true;
    root.classList.add('is-open');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Close chat');
    if (!setupStarted) { setupStarted = true; getConversationId(); } // session + conversation
    // focus after the transition starts so the field is reachable
    setTimeout(function () { input.focus(); }, 120);
    scrollToBottom();
  }

  function closeChat() {
    isOpen = false;
    root.classList.remove('is-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Open chat with DRISS DIGITALS');
    launcher.focus();
  }

  /* --- messages --- */
  function addMessage(text, who) {
    var el = document.createElement('div');
    el.className = 'dd-msg ' + (who === 'user' ? 'dd-msg-user' : 'dd-msg-bot');
    el.textContent = text; // textContent: never inserts HTML
    messages.appendChild(el);
    scrollToBottom();
  }

  function showTyping() {
    typingEl = document.createElement('div');
    typingEl.className = 'dd-typing';
    typingEl.setAttribute('aria-label', 'DRISS DIGITALS is typing');
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    messages.appendChild(typingEl);
    scrollToBottom();
  }

  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function setBusy(state) {
    isBusy = state;
    sendBtn.disabled = state;
  }

  /* --- send flow --- */
  function handleSend(rawText) {
    var text = (rawText || '').trim();
    if (!text || isBusy) return;            // empty-input protection

    quick.hidden = true;                    // hide suggestions after first message
    addMessage(text, 'user');
    input.value = '';
    setBusy(true);
    showTyping();

    saveUserMessage(text); // runs in the background; never blocks or throws

    sendMessageToAssistant(text)
      .then(function (reply) {
        hideTyping();
        addMessage(reply, 'bot');
        // Assistant replies are NOT saved from the browser. RLS only allows
        // browser inserts with sender = 'user'. Once the Netlify Function +
        // LLM is connected, the server will save assistant messages.
      })
      .catch(function () {
        hideTyping();
        addMessage("Sorry, something went wrong. Please try again in a moment.", 'bot');
      })
      .then(function () {                   // runs on success or failure
        setBusy(false);
        if (isOpen) input.focus();
      });
  }

  /* --- events --- */
  launcher.addEventListener('click', function () { isOpen ? closeChat() : openChat(); });
  closeBtn.addEventListener('click', closeChat);

  form.addEventListener('submit', function (e) {
    e.preventDefault();                     // no page reload
    handleSend(input.value);                // Enter key also triggers submit
  });

  quick.addEventListener('click', function (e) {
    var chip = e.target.closest('.dd-chip');
    if (chip) handleSend(chip.textContent);
  });

  root.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) closeChat();
  });

  /* --- start --- */
  addMessage(WELCOME_MESSAGE, 'bot');
})();

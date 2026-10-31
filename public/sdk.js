/*! PlanBridge browser SDK — zero dependencies.
 *
 *   <script src="http://127.0.0.1:3456/sdk.js"></script>
 *   const ai = new PlanBridge({ apiKey: 'pb-…' });
 *   await ai.ask('Hello!');                                   // -> string
 *   await ai.ask('What is this?', { images: [file] });        // File | Blob | data URL | http URL
 *   await ai.ask('Story', { onText: (t, all) => el.textContent = all });   // streaming
 *   const chat = ai.chat({ system: 'You are a pirate' });    // remembers the conversation
 *   await chat.send('Hi'); await chat.send('What did I say?');
 *   await ai.json('A red fruit', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
 */
(function (root) {
  'use strict';

  var scriptOrigin = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      return s ? new URL(s).origin : null;
    } catch (e) {
      return null;
    }
  })();

  function toDataUrl(x) {
    if (typeof x === 'string') return Promise.resolve(x);
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(x);
    });
  }

  async function buildContent(prompt, opts) {
    var images = opts.images || [];
    var files = opts.files || [];
    if (!images.length && !files.length) return prompt;
    var parts = [];
    if (prompt) parts.push({ type: 'text', text: prompt });
    for (var i = 0; i < images.length; i++) parts.push({ type: 'image_url', image_url: { url: await toDataUrl(images[i]) } });
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      parts.push({ type: 'file', file: { filename: f.name || 'file', file_data: await toDataUrl(f) } });
    }
    return parts;
  }

  function PlanBridge(options) {
    if (!(this instanceof PlanBridge)) return new PlanBridge(options);
    options = options || {};
    this.baseUrl = (options.baseUrl || scriptOrigin || 'http://127.0.0.1:3456').replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'sonnet';
    this.system = options.system || '';
    this.effort = options.effort || '';
  }

  PlanBridge.prototype._request = async function (body, onText, signal) {
    var res = await fetch(this.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal,
    });
    if (!res.ok) {
      var msg = res.statusText;
      try { msg = (await res.json()).error.message; } catch (e) {}
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    var sessionId = res.headers.get('X-Session-Id');
    if (!body.stream) {
      var j = await res.json();
      return { text: j.choices[0].message.content, sessionId: j.session_id || sessionId, usage: j.usage, parsed: j.parsed };
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', all = '', usage = null;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        var line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (line.indexOf('data: ') !== 0 || line === 'data: [DONE]') continue;
        var ev = JSON.parse(line.slice(6));
        if (ev.error) throw new Error(ev.error.message);
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.usage) usage = ev.usage;
        var d = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
        if (d) { all += d; onText(d, all); }
      }
    }
    return { text: all, sessionId: sessionId, usage: usage };
  };

  PlanBridge.prototype._body = async function (messages, opts) {
    var body = { model: opts.model || this.model, messages: messages };
    var sys = opts.system != null ? opts.system : this.system;
    if (sys) body.messages = [{ role: 'system', content: sys }].concat(messages);
    var effort = opts.effort || this.effort;
    if (effort) body.reasoning_effort = effort;
    if (opts.onText) { body.stream = true; body.stream_options = { include_usage: true }; }
    if (opts.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: opts.schema } };
    return body;
  };

  /** One-shot question. Returns the answer text. */
  PlanBridge.prototype.ask = async function (prompt, opts) {
    opts = opts || {};
    var content = await buildContent(prompt, opts);
    var body = await this._body([{ role: 'user', content: content }], opts);
    return (await this._request(body, opts.onText, opts.signal)).text;
  };

  /** Structured output validated against a JSON Schema. Returns the parsed object. */
  PlanBridge.prototype.json = async function (prompt, schema, opts) {
    opts = Object.assign({}, opts || {}, { schema: schema, onText: null });
    var body = await this._body([{ role: 'user', content: await buildContent(prompt, opts) }], opts);
    var r = await this._request(body, null, opts.signal);
    return r.parsed !== undefined ? r.parsed : JSON.parse(r.text);
  };

  /** A conversation that remembers previous turns (server-side session). */
  PlanBridge.prototype.chat = function (chatOpts) {
    var self = this;
    chatOpts = chatOpts || {};
    var sessionId = chatOpts.sessionId || null;
    return {
      get sessionId() { return sessionId; },
      send: async function (prompt, opts) {
        opts = Object.assign({}, chatOpts, opts || {});
        var body = await self._body([{ role: 'user', content: await buildContent(prompt, opts) }], opts);
        if (sessionId) body.session_id = sessionId; else body.session = true;
        var r = await self._request(body, opts.onText, opts.signal);
        sessionId = r.sessionId || sessionId;
        return r.text;
      },
      reset: function () { sessionId = null; },
    };
  };

  /** Is the local server up? */
  PlanBridge.prototype.health = async function () {
    try { return (await fetch(this.baseUrl + '/health')).ok; } catch (e) { return false; }
  };

  /** Plan usage (5-hour / 7-day windows), as last reported by Claude Code. */
  PlanBridge.prototype.limits = async function () {
    var r = await fetch(this.baseUrl + '/v1/limits', { headers: { Authorization: 'Bearer ' + this.apiKey } });
    return (await r.json()).rate_limit;
  };

  root.PlanBridge = PlanBridge;
  if (typeof module === 'object' && module.exports) module.exports = PlanBridge;
})(typeof window !== 'undefined' ? window : globalThis);

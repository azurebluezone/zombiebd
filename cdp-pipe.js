#!/usr/bin/env node
'use strict';

/**
 * cdp-pipe.js — headless Chrome over --remote-debugging-pipe (ZERO HTTP).
 *
 * 🧟 Ethical browsing tool (#7):
 *   Chrome is launched with `--remote-debugging-pipe`. CDP JSON messages
 *   travel over **file descriptor 3 (write) / 4 (read)** with `\0` framing.
 *   → No debug port, no TCP, no WebSocket, no HTTP anywhere in the
 *     control channel. Nothing can snarf the DevTools socket.
 *   The PAGE itself may load http(s)/file URLs — that is Chrome doing
 *     its job; OUR code never opens a socket.
 *
 * Zero-dependency, CommonJS.
 *
 * ── What changed in v2 (this rewrite) ─────────────────────────────────────
 *   The old build could only return text / html / title / a base64 screenshot,
 *   one shot per call, closing the tab immediately. That made real visual
 *   inspection ("what does this page actually look like?") painful.
 *   v2 keeps the zero-HTTP pipe design and adds:
 *     • persistent page session (keep_open) → multi-step inspection
 *     • screenshot to a FILE (PNG on disk) so OCR can read it
 *     • full-page screenshots (captureBeyondViewport + clip)
 *     • custom JavaScript eval (Runtime.evaluate)
 *     • console + uncaught-error capture (Runtime.consoleAPICalled / exceptionThrown)
 *     • design introspection: computed styles, element query, page outline, links
 *     • configurable viewport / device scale
 *   All screenshots are written under TMP_ROOT/cdp-shots and their PATH is
 *   returned (base64 only when explicitly asked) so payloads stay small.
 *
 * Public API (backward compatible):
 *   browseCdp({ url, action, timeout_ms }) → Promise<object>
 *   new CDPipe(opts) / .browse(opts) / .stop()
 *
 * Actions: text | html | title | url | info | screenshot | screenshot_full
 *          | eval | wait | query | styles | outline | links | console
 * CLI:  node cdp-pipe.js <url> [action] [extraJson]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME_BIN = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const TMP_ROOT = process.env.CDP_TMP_DIR || '/tmp/opencode';
const SHOT_DIR = path.join(TMP_ROOT, 'cdp-shots');
const DEFAULT_TIMEOUT = 20000;
const MAX_EVENTS = 500;

const ACTIONS = new Set([
  'text', 'html', 'title', 'url', 'info', 'screenshot', 'screenshot_full',
  'eval', 'wait', 'query', 'styles', 'outline', 'links', 'console',
]);

// Computed-style properties worth reading when auditing a design.
const STYLE_PROPS = [
  'display', 'position', 'width', 'height', 'color', 'backgroundColor',
  'backgroundImage', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
  'letterSpacing', 'textTransform', 'borderRadius', 'boxShadow', 'padding',
  'margin', 'borderColor',
];

class CDPipe {
  constructor(opts = {}) {
    this.proc = null;
    this.msgId = 0;
    this.pending = new Map(); // id → {resolve, reject, timer}
    this.buf = '';
    this.toChild = null;
    this.fromChild = null;
    this.exited = false;

    // Event bus (console logs, load events, …)
    this.events = [];
    this.listeners = new Map();

    // Persistent page (only when a caller asks to keep it open)
    this.page = null;

    this.viewport = opts.viewport || { width: 1440, height: 900, deviceScaleFactor: 1 };
  }

  start() {
    if (this.proc) return Promise.resolve();
    if (!fs.existsSync(CHROME_BIN)) {
      throw new Error('chrome binary not found: ' + CHROME_BIN);
    }
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const profile = path.join(TMP_ROOT, 'cdp-pipe-profile-' + Date.now());
    fs.mkdirSync(profile, { recursive: true });
    // stdio[0]=ignore, [1]=pipe(chrome stdout, unused by pipe mode),
    // [2]=pipe(stderr), [3]=pipe → CDP write channel, [4]=pipe → CDP read.
    this.proc = spawn(
      CHROME_BIN,
      [
        '--headless=new',
        '--remote-debugging-pipe',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        '--hide-crash-restore-bubble',
        '--font-render-hinting=none',
        '--force-color-profile=srgb',
        '--window-size=' + this.viewport.width + ',' + this.viewport.height,
        '--user-data-dir=' + profile,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
    );
    this.toChild = this.proc.stdio[3];
    this.fromChild = this.proc.stdio[4];
    this.fromChild.setEncoding('utf8');
    this.fromChild.on('data', (chunk) => this._onData(chunk));
    this.proc.on('exit', (code) => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('chrome exited (code ' + code + ')'));
      }
      this.pending.clear();
    });
    this.proc.stderr.on('data', () => {}); // keep drained
    // Give chrome a moment to spin up its pipe endpoint
    return new Promise((r) => setTimeout(r, 400));
  }

  // ─── Event bus ───────────────────────────────────────────────────
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  _emit(msg) {
    const rec = { method: msg.method, params: msg.params || {}, sessionId: msg.sessionId };
    this.events.push(rec);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const fns = this.listeners.get(msg.method) || [];
    for (const fn of fns.slice()) {
      try { fn(msg); } catch (_) { /* listener errors are not fatal */ }
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\0')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'cdp error'));
        else p.resolve(msg.result || {});
      } else if (msg.method) {
        this._emit(msg);
      }
    }
  }

  send(method, params, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.toChild) return reject(new Error('chrome not running'));
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, timeoutMs || DEFAULT_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({
        id, method, params: params || {}, ...(sessionId ? { sessionId } : {}),
      });
      this.toChild.write(payload + '\0');
    });
  }

  async eval(expression, sessionId, timeoutMs) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval error: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result ? r.result.value : null;
  }

  _waitEvent(method, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const off = this.on(method, (m) => {
        if (done) return;
        done = true; off(); resolve(m);
      });
      setTimeout(() => {
        if (done) return;
        done = true; off(); resolve(null);
      }, timeoutMs || DEFAULT_TIMEOUT);
    });
  }

  // ─── Page lifecycle ──────────────────────────────────────────────
  async ensurePage({ keepOpen = false } = {}) {
    if (keepOpen && this.page) return this.page;
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = { targetId, sessionId };
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    try { await this.send('Log.enable', {}, sessionId); } catch (_) {}
    try {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: this.viewport.deviceScaleFactor || 1,
        mobile: false,
      }, sessionId);
    } catch (_) {}
    if (keepOpen) this.page = page;
    return page;
  }

  async closePage(page) {
    const p = page || this.page;
    if (!p) return;
    try { await this.send('Target.closeTarget', { targetId: p.targetId }); } catch (_) {}
    if (this.page && this.page.targetId === p.targetId) this.page = null;
  }

  async navigate(page, url, timeoutMs) {
    const navigation = this._waitEvent('Page.loadEventFired', timeoutMs || DEFAULT_TIMEOUT);
    const nav = await this.send('Page.navigate', { url }, page.sessionId, timeoutMs || DEFAULT_TIMEOUT);
    if (nav.errorText) throw new Error('navigate: ' + nav.errorText);
    await navigation;
    // Fallback for pages that never fire loadEventFired (e.g. cached redirects).
    const deadline = Date.now() + 3000;
    let ready = await this.eval('document.readyState', page.sessionId).catch(() => 'complete');
    while (ready === 'loading' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      ready = await this.eval('document.readyState', page.sessionId).catch(() => 'complete');
    }
  }

  consoleMessages() {
    const out = [];
    for (const ev of this.events) {
      if (ev.method === 'Runtime.consoleAPICalled') {
        const p = ev.params;
        out.push({
          level: p.type,
          text: (p.args || [])
            .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ''))
            .join(' '),
        });
      } else if (ev.method === 'Runtime.exceptionThrown') {
        const d = ev.params.exceptionDetails || {};
        out.push({ level: 'error', text: d.exception ? d.exception.description : d.text });
      } else if (ev.method === 'Log.entryAdded') {
        const e = ev.params.entry || {};
        out.push({ level: e.level, text: e.text, source: e.url });
      }
    }
    return out;
  }

  async captureScreenshot(page, { fullPage = false } = {}) {
    let params = { format: 'png' };
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics', {}, page.sessionId);
      const size = m.cssContentSize || m.contentSize || { width: this.viewport.width, height: this.viewport.height };
      params = {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0, y: 0,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          scale: 1,
        },
      };
    }
    const shot = await this.send('Page.captureScreenshot', params, page.sessionId);
    const file = path.join(SHOT_DIR, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data || '', 'base64'));
    return { path: file, bytes: fs.statSync(file).size };
  }

  // ─── Actions ─────────────────────────────────────────────────────
  async performAction(action, page, opts) {
    const s = page.sessionId;
    switch (action) {
      case 'title':
        return { title: await this.eval('document.title', s) };

      case 'url':
        return { url: await this.eval('location.href', s) };

      case 'html':
        return { html: await this.eval('document.documentElement.outerHTML', s) };

      case 'screenshot': {
        const shot = await this.captureScreenshot(page, { fullPage: false });
        return { screenshot_path: shot.path, screenshot_bytes: shot.bytes, full_page: false };
      }

      case 'screenshot_full': {
        const shot = await this.captureScreenshot(page, { fullPage: true });
        return { screenshot_path: shot.path, screenshot_bytes: shot.bytes, full_page: true };
      }

      case 'eval': {
        if (!opts.expression) throw new Error('action=eval requires `expression`');
        return { value: await this.eval(opts.expression, s, opts.timeout_ms) };
      }

      case 'wait': {
        const ms = Number(opts.wait_ms || opts.timeout_ms || 1000);
        if (opts.selector) {
          const deadline = Date.now() + (opts.timeout_ms || DEFAULT_TIMEOUT);
          let found = false;
          while (Date.now() < deadline) {
            found = await this.eval(
              `!!document.querySelector(${JSON.stringify(opts.selector)})`, s,
            ).catch(() => false);
            if (found) break;
            await new Promise((r) => setTimeout(r, 150));
          }
          return { waited_for: opts.selector, found };
        }
        await new Promise((r) => setTimeout(r, ms));
        return { waited_ms: ms };
      }

      case 'query': {
        const sel = opts.selector || 'body';
        const limit = Math.min(Number(opts.limit || 25), 200);
        return {
          selector: sel,
          elements: await this.eval(
            `(() => {
               const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).slice(0, ${limit});
               return els.map((el) => {
                 const r = el.getBoundingClientRect();
                 const attrs = {};
                 for (const k of ['src','href','alt','title','data-src']) {
                   const v = el.getAttribute && el.getAttribute(k);
                   if (v) attrs[k] = v.slice(0, 300);
                 }
                 return {
                   tag: el.tagName.toLowerCase(),
                   id: el.id || null,
                   classes: (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean),
                   text: (el.innerText || el.textContent || '').trim().slice(0, 300),
                   rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                   attrs,
                 };
               });
             })()`, s,
          ),
        };
      }

      case 'styles': {
        const sel = opts.selector || 'body';
        const props = STYLE_PROPS;
        return {
          selector: sel,
          styles: await this.eval(
            `(() => {
               const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).slice(0, 10);
               const props = ${JSON.stringify(props)};
               return els.map((el) => {
                 const cs = getComputedStyle(el);
                 const out = {};
                 for (const p of props) out[p] = cs[p];
                 return { tag: el.tagName.toLowerCase(), id: el.id || null, classes: (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean), styles: out };
               });
             })()`, s,
          ),
          css_variables: await this.eval(
            `(() => {
               const out = {};
               const cs = getComputedStyle(document.documentElement);
               for (const name of (cs.cssText || '').split(/;\\s*/)) {
                 const m = name.match(/^(-{1,2}[\\w-]+)\\s*:\\s*(.+)$/);
                 if (m) out[m[1]] = m[2];
               }
               return out;
             })()`, s,
          ).catch(() => ({})),
        };
      }

      case 'outline': {
        return {
          outline: await this.eval(
            `(() => {
               const out = [];
               document.querySelectorAll('h1,h2,h3,h4,h5,h6,header,nav,main,section,article,aside,footer').forEach((el) => {
                 const r = el.getBoundingClientRect();
                 out.push({
                   tag: el.tagName.toLowerCase(),
                   text: (el.innerText || '').trim().replace(/\\s+/g,' ').slice(0, 120),
                   rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                 });
               });
               return out;
             })()`, s,
          ),
        };
      }

      case 'links': {
        return {
          links: await this.eval(
            `Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map((a) => ({
               text: (a.innerText || a.textContent || '').trim().slice(0, 120),
               href: a.href,
             }))`, s,
          ),
        };
      }

      case 'console':
        return { console: this.consoleMessages().slice(0, Number(opts.limit || 200)) };

      case 'info':
      default: {
        const info = await this.eval(
          `(() => ({
             title: document.title,
             url: location.href,
             viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
             document: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
             body_font: getComputedStyle(document.body).fontFamily,
             body_bg: getComputedStyle(document.body).backgroundColor,
             counts: {
               images: document.images.length,
               links: document.links.length,
               headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
               forms: document.forms.length,
             },
           }))()`, s,
        );
        if (action === 'text') {
          return { text: await this.eval("document.body ? document.body.innerText : ''", s), info };
        }
        return { info };
      }
    }
  }

  async browse(opts = {}) {
    let { url, action = 'text', timeout_ms } = opts;
    if (opts.action && !ACTIONS.has(opts.action)) {
      throw new Error('unknown action: ' + opts.action + ' (one of: ' + [...ACTIONS].join(', ') + ')');
    }
    if (url != null && url !== '') {
      if (typeof url !== 'string' || !/^(https?:|file:|about:)/i.test(url.trim())) {
        throw new Error('url must start with http:// https:// file:// or about:');
      }
      url = url.trim();
    }
    await this.start();
    const keepOpen = !!opts.keep_open;
    const page = await this.ensurePage({ keepOpen });
    try {
      if (url && url !== 'about:blank') await this.navigate(page, url, timeout_ms);
      if (opts.action === 'wait' || opts.wait_ms || opts.selector) {
        // allow a settle/wait step before reading
        if (opts.wait_ms && opts.action !== 'wait') {
          await new Promise((r) => setTimeout(r, Number(opts.wait_ms)));
        }
      }
      const data = await this.performAction(action === 'wait' ? 'wait' : action, page, opts);
      const title = await this.eval('document.title', page.sessionId).catch(() => '');
      const finalUrl = await this.eval('location.href', page.sessionId).catch(() => url || '');
      const out = { ok: true, url: finalUrl || url || '', title: title || '', action, ...data };
      return out;
    } finally {
      if (!keepOpen) await this.closePage(page);
    }
  }

  stop() {
    if (this.proc && !this.exited) {
      try { this.toChild && this.toChild.end(); } catch (_) {}
      this.proc.kill('SIGKILL');
    }
    this.proc = null;
    this.page = null;
  }
}

// ─── Shared lazy instance (one chrome for the process, reused) ──
let shared = null;
async function browseCdp(opts) {
  if (!shared || shared.exited) shared = new CDPipe(opts && opts.viewport ? { viewport: opts.viewport } : {});
  return await shared.browse(opts || {});
}
function stopCdp() {
  if (shared) shared.stop();
  shared = null;
}

module.exports = { CDPipe, browseCdp, stopCdp, ACTIONS };

// ─── CLI self-test (pipe only, zero HTTP from this script) ──────
//   node cdp-pipe.js <url> [action] [extraJson]
if (require.main === module) {
  (async () => {
    const url = process.argv[2] || 'about:blank';
    const action = process.argv[3] || 'text';
    const extra = process.argv[4] ? JSON.parse(process.argv[4]) : {};
    const c = new CDPipe();
    try {
      const r = await c.browse({ url, action, ...extra });
      const copy = { ...r };
      if (copy.html && copy.html.length > 400) copy.html = copy.html.slice(0, 400) + '…';
      if (copy.text && copy.text.length > 1200) copy.text = copy.text.slice(0, 1200) + '…';
      console.log(JSON.stringify(copy, null, 2));
    } finally {
      c.stop();
    }
  })().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
}

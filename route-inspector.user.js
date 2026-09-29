// ==UserScript==
// @name         ChatGPT Route Inspector
// @namespace    local.chatgpt.inspector
// @version      1.0
// @description  Live panel showing the model-routing metadata ChatGPT's server exposes to the client for /backend-api/f/conversation
// @author       local
// @match        https://chatgpt.com/*
// @match        https://*.chatgpt.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

/*
 * WHAT THIS IS
 *   A local, read-only observer of the model-routing metadata that chatgpt.com's
 *   server sends back to the browser for a normal web chat turn.
 *
 * WHAT THIS IS NOT
 *   It is NOT proof of which physical GPU loaded which weights. It only reports
 *   the routing metadata the server chose to expose to the client:
 *     Request Model   -> request body "model"
 *     Assistant Model -> message.metadata.model_slug
 *     Resolved Model  -> message.metadata.resolved_model_slug
 *     Server STE      -> type === "server_ste_metadata" . metadata.model_slug
 *     Region          -> ... . metadata.cluster_region
 *     Plan            -> ... . metadata.plan_type
 *
 * DESIGN RULES
 *   1. Fail open. Any error in here must never break ChatGPT. Everything is
 *      wrapped; nothing is rethrown into page code.
 *   2. Never consume the page's own response body. Only res.clone() is read.
 *   3. No network egress of its own. No prompt, no reply text, no chat history
 *      is ever stored, logged or transmitted. Metadata keys only.
 *   4. Cheap. No polling timers; a single MutationObserver with a coalesced
 *      rAF repaint.
 */

(function () {
    'use strict';

    var VERSION = '1.0';

    // Page context. With @sandbox raw this IS the page window; with Tampermonkey's
    // default sandbox, unsafeWindow is the real page window. Either way the fetch
    // hook must land on the object the page actually calls.
    var W;
    try { W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window; } catch (e) { W = window; }
    var D = W.document;

    // The single endpoint that is a real chat turn (POST + SSE). A new turn is
    // ONLY started here - /conversation/init, /f/conversation/prepare and
    // /conversations/batch fire constantly and must never wipe the panel.
    var TURN_PATH = '/backend-api/f/conversation';
    var TARGET_STRICT = /\/backend-api\/f\/conversation/;
    var TARGET_LOOSE = /\/backend-api\/conversation/;       // older/other shapes
    var PANEL_ID = 'ri-panel';
    var MAX_BUFFER = 4000000;      // hard ceiling on the SSE carry buffer
    var MAX_SNIFF = 400000;        // max chars handed to one raw-text scan

    // ------------------------------------------------------------------
    // 1. Diagnostics - rendered on the panel so DevTools is never required
    //    to tell "never ran" apart from "ran but captured nothing".
    // ------------------------------------------------------------------
    var diag = {
        started: false,
        mounted: false,
        fetchHooked: false,
        xhrHooked: false,
        esHooked: false,
        pageCtx: false,
        fetchCalls: 0,
        targetHits: 0,
        exactHits: 0,
        otherHits: 0,
        streams: 0,
        events: 0,
        parseErrors: 0,
        lastPath: '(none)',
        lastCtype: '(none)',
        lastBodyKind: '(none)',
        pathCounts: {},
        allPaths: {},     // UNFILTERED /backend-api/* histogram (coverage proof)
        src: {},          // which endpoint supplied each field
        pendingReq: null, // model seen on /f/conversation/prepare
        streamStats: { chunks: 0, bytes: 0, lines: 0, dataLines: 0, braceStart: 0, dataStart: 0 },
        lastError: '(none)',
        note: '(none)'
    };

    var state = {
        status: 'STARTING',
        turn: 0,
        requestModel: null,     // request.model
        assistantModel: null,   // message.metadata.model_slug
        resolvedModel: null,    // message.metadata.resolved_model_slug
        steModel: null,         // server_ste_metadata.metadata.model_slug
        clusterRegion: null,    // server_ste_metadata.metadata.cluster_region
        planType: null,         // server_ste_metadata.metadata.plan_type
        lastSeen: null
    };

    // Panel shows four rows only. resolvedModel is still captured (the
    // extraction layer is untouched) but is intentionally not displayed.
    var ROWS = [
        ['requestModel', '请求模型'],
        ['steModel', '路由模型'],
        ['assistantModel', '回答模型'],
        ['regionPlan', '区域套餐']
    ];

    var WAITING = '等待中...';

    // Internal statuses stay as-is so the offline test harness keeps working;
    // only the rendered text is translated.
    var STATUS_CN = {
        'STARTING': '启动中',
        'READY': '就绪',
        'REQUEST SENT': '已发送',
        'STREAMING': '正在响应...',
        'CAPTURED': '已捕获',
        'STREAM ENDED': '已结束',
        'ABORTED BY PAGE': '已中断',
        'REQUEST FAILED': '请求失败'
    };

    function statusText() {
        return STATUS_CN[state.status] || state.status;
    }

    function note(msg) {
        diag.note = msg;
        try { console.log('[RI] ' + msg); } catch (e) {}
        scheduleRender();
    }

    function fail(stage, e) {
        diag.lastError = stage + ': ' + ((e && e.message) || String(e));
        try { console.warn('[RI] ' + diag.lastError); } catch (err) {}
        scheduleRender();
    }

    function isTopFrame() {
        try { return W.top === W.self; } catch (e) { return false; }
    }

    // ------------------------------------------------------------------
    // 2. Panel
    // ------------------------------------------------------------------
    var host = null;         // outer element we own -> #ri-panel
    var root = null;         // shadow root (or host itself as fallback)
    var nodes = {};          // field name -> value node
    var statusNode = null;
    var renderQueued = false;

    // Window state. Hidden until a real conversation turn is seen, so the panel
    // can never cover ChatGPT's own model picker on first load.
    var ui = {
        visible: false,     // currently shown?
        closed: false,      // "x" pressed -> stay silent until the page reloads
        x: null,            // dragged position (px, viewport coords)
        y: null,
        dragged: false
    };

    var CSS = [
        ':host{all:initial}',
        '.box{position:fixed;right:14px;bottom:14px;z-index:2147483647;',
        'min-width:268px;max-width:400px;background:#101014;color:#f4f4f5;',
        'border:1px solid rgba(255,255,255,.22);border-radius:9px;',
        'box-shadow:0 8px 28px rgba(0,0,0,.45);',
        'font:12px/1.45 ui-monospace,Consolas,Menlo,monospace;',
        'padding:0;overflow:hidden}',
        '.hd{display:flex;align-items:center;gap:8px;cursor:move;',
        'padding:7px 8px 7px 10px;background:#17171d;',
        'border-bottom:1px solid rgba(255,255,255,.12);user-select:none}',
        '.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex:0 0 auto}',
        '.ttl{font-weight:700;letter-spacing:.3px;color:#7dd3fc;flex:1 1 auto;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.btns{display:flex;gap:4px;flex:0 0 auto}',
        '.btn{width:20px;height:20px;line-height:18px;text-align:center;',
        'border-radius:5px;background:rgba(255,255,255,.08);color:#d4d4d8;',
        'cursor:pointer;font-size:13px;user-select:none}',
        '.btn:hover{background:rgba(255,255,255,.2);color:#fff}',
        '.bd{padding:8px 10px 9px}',
        '.r{display:flex;gap:8px;align-items:baseline;margin:2px 0}',
        '.k{flex:0 0 74px;color:#a1a1aa}',
        '.v{flex:1 1 auto;word-break:break-all;color:#71717a}',
        '.v.set{color:#4ade80}',
        '.st{margin:0 0 6px;color:#facc15;font-size:11px}'
    ].join('');

    function build() {
        if (host && host.isConnected) return host;

        host = D.createElement('div');
        host.id = PANEL_ID;
        host.setAttribute('data-ri-version', VERSION);
        // hidden until a real turn shows up
        host.style.display = 'none';

        try {
            root = host.attachShadow({ mode: 'open' });
        } catch (e) {
            root = host;   // extremely old engines only
        }

        var style = D.createElement('style');
        style.textContent = CSS;
        root.appendChild(style);

        var box = D.createElement('div');
        box.className = 'box';

        var hd = D.createElement('div');
        hd.className = 'hd';

        var dot = D.createElement('div');
        dot.className = 'dot';

        var ttl = D.createElement('div');
        ttl.className = 'ttl';
        ttl.textContent = 'ChatGPT 路由检查器';

        var btns = D.createElement('div');
        btns.className = 'btns';

        var btnMin = D.createElement('div');
        btnMin.className = 'btn';
        btnMin.textContent = '\u2014';          // em dash = minimize
        btnMin.title = '最小化（下次提问会重新弹出）';

        var btnClose = D.createElement('div');
        btnClose.className = 'btn';
        btnClose.textContent = '\u00d7';        // multiplication sign = close
        btnClose.title = '关闭（刷新页面前不再弹出）';

        btns.appendChild(btnMin);
        btns.appendChild(btnClose);

        hd.appendChild(dot);
        hd.appendChild(ttl);
        hd.appendChild(btns);

        var bd = D.createElement('div');
        bd.className = 'bd';

        statusNode = D.createElement('div');
        statusNode.className = 'st';
        bd.appendChild(statusNode);

        ROWS.forEach(function (r) {
            var row = D.createElement('div');
            row.className = 'r';

            var k = D.createElement('div');
            k.className = 'k';
            k.textContent = r[1];

            var v = D.createElement('div');
            v.className = 'v';
            v.textContent = WAITING;

            row.appendChild(k);
            row.appendChild(v);
            bd.appendChild(row);
            nodes[r[0]] = v;
        });

        box.appendChild(hd);
        box.appendChild(bd);

        btnMin.addEventListener('click', function (e) {
            try { if (e && e.stopPropagation) e.stopPropagation(); } catch (err) {}
            hidePanel();
        });
        btnClose.addEventListener('click', function (e) {
            try { if (e && e.stopPropagation) e.stopPropagation(); } catch (err) {}
            closePanel();
        });

        enableDrag(hd);

        root.appendChild(box);
        panelBox = box;
        return host;
    }

    var panelBox = null;
    var drag = null;

    // Drag the whole window by its title bar. Uses document-level move/up so a
    // fast flick that leaves the header (or the window) still tracks.
    function enableDrag(handle) {
        try {
            handle.addEventListener('mousedown', function (e) {
                try {
                    if (e.button !== 0) return;
                    if (!panelBox) return;
                    var r = panelBox.getBoundingClientRect ? panelBox.getBoundingClientRect() : null;
                    if (!r) return;
                    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
                    ui.dragged = true;
                    try { D.body.style.userSelect = 'none'; } catch (err) {}
                    if (e.preventDefault) e.preventDefault();
                } catch (err) { fail('drag start', err); }
            });

            D.addEventListener('mousemove', function (e) {
                if (!drag || !panelBox) return;
                try {
                    var w = W.innerWidth || 1200;
                    var h = W.innerHeight || 800;
                    var bw = panelBox.offsetWidth || 300;
                    var bh = panelBox.offsetHeight || 120;
                    var x = e.clientX - drag.dx;
                    var y = e.clientY - drag.dy;
                    // keep at least a sliver on screen
                    if (x < 4) x = 4;
                    if (y < 4) y = 4;
                    if (x > w - bw - 4) x = Math.max(4, w - bw - 4);
                    if (y > h - bh - 4) y = Math.max(4, h - bh - 4);
                    ui.x = x;
                    ui.y = y;
                    panelBox.style.left = x + 'px';
                    panelBox.style.top = y + 'px';
                    panelBox.style.right = 'auto';
                    panelBox.style.bottom = 'auto';
                } catch (err) { fail('drag move', err); }
            });

            D.addEventListener('mouseup', function () {
                if (!drag) return;
                drag = null;
                try { D.body.style.userSelect = ''; } catch (err) {}
            });
        } catch (e) {
            fail('enableDrag', e);
        }
    }

    function showPanel() {
        try {
            if (ui.closed) return;          // "x" is a hard stop until reload
            if (!host || !host.isConnected) mount('show');
            if (!host) return;
            host.style.display = '';
            ui.visible = true;
        } catch (e) { fail('showPanel', e); }
    }

    function hidePanel() {
        try {
            if (host) host.style.display = 'none';
            ui.visible = false;
        } catch (e) { fail('hidePanel', e); }
    }

    function closePanel() {
        try {
            ui.closed = true;
            hidePanel();
            note('panel closed by user');
        } catch (e) { fail('closePanel', e); }
    }

    function mount(why) {
        try {
            var h = build();
            if (h.isConnected) return true;
            var target = D.body || D.documentElement;
            if (!target) return false;
            target.appendChild(h);
            diag.mounted = !!h.isConnected;
            // mounting never implies visibility
            h.style.display = (ui.visible && !ui.closed) ? '' : 'none';
            if (diag.mounted) {
                try { console.log('[RI] panel mounted (' + why + ')'); } catch (e) {}
            }
            scheduleRender();
            return diag.mounted;
        } catch (e) {
            fail('mount(' + why + ')', e);
            return false;
        }
    }

    // Keep the panel in <body> if a framework wiped or re-parented it.
    function toBody() {
        try {
            if (!host || !host.isConnected) { mount('toBody'); return; }
            if (D.body && host.parentNode !== D.body) D.body.appendChild(host);
        } catch (e) {
            fail('toBody', e);
        }
    }

    function regionPlanText() {
        if (!state.clusterRegion && !state.planType) return null;
        return (state.clusterRegion || 'N/A') + ' / ' + (state.planType || 'N/A');
    }

    function valueFor(key) {
        if (key === 'regionPlan') return regionPlanText();
        return state[key];
    }

    function paint() {
        renderQueued = false;
        try {
            if (!host || !host.isConnected) return;

            statusNode.textContent = statusText() +
                '   第 ' + state.turn + ' 轮' +
                (state.lastSeen ? '  ' + state.lastSeen : '');

            ROWS.forEach(function (r) {
                var el = nodes[r[0]];
                if (!el) return;
                var v = valueFor(r[0]);
                if (v === null || v === undefined || v === '') {
                    el.textContent = WAITING;
                    el.className = 'v';
                } else {
                    el.textContent = String(v);
                    el.className = 'v set';
                }
            });
        } catch (e) {
            fail('paint', e);
        }
    }

    function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        try {
            if (typeof W.requestAnimationFrame === 'function') {
                W.requestAnimationFrame(function () { try { paint(); } catch (e) { renderQueued = false; } });
            } else {
                setTimeout(function () { try { paint(); } catch (e) { renderQueued = false; } }, 16);
            }
        } catch (e) {
            renderQueued = false;
        }
    }

    // ------------------------------------------------------------------
    // 3. Metadata harvesting
    // ------------------------------------------------------------------
    function str(obj, keys) {
        if (!obj || typeof obj !== 'object') return null;
        for (var i = 0; i < keys.length; i++) {
            var v = obj[keys[i]];
            if (typeof v === 'string' && v) return v;
        }
        return null;
    }

    // STE metadata is frequently double-encoded: a JSON string inside JSON.
    function maybeJson(s) {
        if (typeof s !== 'string' || s.length < 12 || s.length > 300000) return null;
        var a = s.indexOf('{');
        if (a === -1) return null;
        var b = s.lastIndexOf('}');
        if (b <= a) return null;
        try {
            var o = JSON.parse(s.slice(a, b + 1));
            return (o && typeof o === 'object') ? o : null;
        } catch (e) { return null; }
    }

    function looksLikeSte(obj) {
        // A metadata blob that carries cluster_region/plan_type is STE-shaped; it
        // must not be mistaken for the assistant message metadata.
        return !!(obj && typeof obj === 'object' &&
            (obj.cluster_region || obj.plan_type || obj.type === 'server_ste_metadata'));
    }

    function takeSte(out, meta) {
        if (!meta || typeof meta !== 'object') return;
        if (!out.steModel) out.steModel = str(meta, ['model_slug', 'model']);
        if (!out.clusterRegion) out.clusterRegion = str(meta, ['cluster_region', 'cluster']);
        if (!out.planType) out.planType = str(meta, ['plan_type', 'plan']);
    }

    function harvestObject(rootObj) {
        var out = {};
        var stack = [rootObj];
        var seen = 0;

        while (stack.length && seen < 5000) {
            var cur = stack.pop();
            seen++;
            if (!cur || typeof cur !== 'object') continue;

            // (a) STE, wrapped form:  { server_ste_metadata: { metadata: {...} } }
            if (cur.server_ste_metadata) {
                var s = cur.server_ste_metadata;
                takeSte(out, s.metadata || s);
            }

            // (b) STE, flat form:     { type: "server_ste_metadata", metadata: {...} }
            if (cur.type === 'server_ste_metadata') {
                takeSte(out, cur.metadata || cur);
            }

            // (c) assistant / resolved, but never from an STE-shaped blob
            if (cur.metadata && !looksLikeSte(cur.metadata)) {
                if (!out.assistantModel) out.assistantModel = str(cur.metadata, ['model_slug']);
                if (!out.resolvedModel) out.resolvedModel = str(cur.metadata, ['resolved_model_slug']);
            }

            for (var k in cur) {
                if (!Object.prototype.hasOwnProperty.call(cur, k)) continue;
                var child = cur[k];
                if (child && typeof child === 'object') {
                    stack.push(child);
                } else if (typeof child === 'string' && child.indexOf('{') !== -1 && child.length < 300000) {
                    var un = maybeJson(child);
                    if (un) stack.push(un);
                }
            }
        }
        return out;
    }

    // Bounded brace scanner: the balanced {...} that starts at/after `from`.
    function rawObject(text, from) {
        try {
            var brace = text.indexOf('{', from);
            if (brace === -1) return null;
            var depth = 0, inStr = false, esc = false;
            for (var i = brace; i < text.length; i++) {
                var c = text.charAt(i);
                if (inStr) {
                    if (esc) esc = false;
                    else if (c === '\\') esc = true;
                    else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') { inStr = true; continue; }
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) return text.slice(brace, i + 1); }
            }
        } catch (e) { fail('rawObject', e); }
        return null;
    }

    // Raw-text sweep. Survives escaped payloads, torn frames and non-JSON events.
    function harvestText(text) {
        var out = {};
        var idx = text.indexOf('server_ste_metadata');

        if (idx !== -1) {
            var raw = rawObject(text, idx);
            if (raw) {
                try {
                    var obj = JSON.parse(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
                    takeSte(out, (obj && obj.metadata) || obj);
                } catch (e) { diag.parseErrors++; }
            }
            if (!out.steModel && !out.clusterRegion && !out.planType) {
                var win = text.slice(idx, idx + 1600);
                var a = /"model_slug"\s*:\s*"([^"\\]*)"/.exec(win);
                var b = /"cluster_region"\s*:\s*"([^"\\]*)"/.exec(win);
                var c = /"plan_type"\s*:\s*"([^"\\]*)"/.exec(win);
                if (a) out.steModel = a[1];
                if (b) out.clusterRegion = b[1];
                if (c) out.planType = c[1];
            }
        }
        if (!out.resolvedModel) {
            var r = /"resolved_model_slug"\s*:\s*"([^"\\]*)"/.exec(text);
            if (r) out.resolvedModel = r[1];
        }
        if (!out.assistantModel) {
            // last "model_slug" that is not sitting inside an STE blob
            var all = text.match(/"model_slug"\s*:\s*"([^"\\]*)"/g);
            if (all && all.length) {
                var last = all[all.length - 1];
                var mm = /"model_slug"\s*:\s*"([^"\\]*)"/.exec(last);
                if (mm) out.assistantModel = mm[1];
            }
        }
        if (!out.clusterRegion) {
            var c2 = /"cluster_region"\s*:\s*"([^"\\]*)"/.exec(text);
            if (c2) out.clusterRegion = c2[1];
        }
        if (!out.planType) {
            var p2 = /"plan_type"\s*:\s*"([^"\\]*)"/.exec(text);
            if (p2) out.planType = p2[1];
        }
        return out;
    }

    // Fields remember how authoritative their current value is. A value from the
    // real turn endpoint (priority 2) always beats one from a side endpoint such
    // as /f/conversation/prepare or /conversation/init (priority 1); a side
    // endpoint may only fill a field that is still empty. That keeps the panel
    // honest without letting a stray batch response overwrite a real turn.
    var fieldPrio = {};

    function apply(found, prio, source) {
        if (!found) return;
        prio = prio || 1;
        var changed = false;
        Object.keys(found).forEach(function (k) {
            var v = found[k];
            if (v === undefined || v === null || v === '') return;
            var have = state[k];
            var havePrio = fieldPrio[k] || 0;
            if (have === v) return;
            if (have !== null && have !== undefined && prio < havePrio) return;
            state[k] = v;
            fieldPrio[k] = prio;
            if (source) diag.src[k] = prio + ':' + source;
            changed = true;
        });
        if (changed) {
            state.lastSeen = new Date().toLocaleTimeString();
            scheduleRender();
        }
    }

    // ------------------------------------------------------------------
    // 4. SSE
    // ------------------------------------------------------------------
    // Correct incremental parser: a network chunk is NOT a JSON message.
    // Complete "data:" lines are consumed; the tail stays in the buffer.
    function feed(chunkText, prio, source) {
        if (!chunkText) return;
        try {
            var nl = -1;
            var sawFirst = false;
            while ((nl = chunkText.indexOf('\n')) !== -1) {
                var line = chunkText.slice(0, nl);
                chunkText = chunkText.slice(nl + 1);
                if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // CRLF
                if (!sawFirst) {
                    sawFirst = true;
                    if (line.charAt(0) === '{') diag.streamStats.braceStart++;
                    if (line.indexOf('data:') === 0) diag.streamStats.dataStart++;
                }
                feedLine(line, prio, source);
            }
            feedLine(chunkText, prio, source);
            // Raw sweep over anything left / torn, bounded so a broken stream
            // can never grow memory without limit.
            apply(harvestText(chunkText.length > MAX_SNIFF ? chunkText.slice(-MAX_SNIFF) : chunkText), prio, source);
        } catch (e) {
            fail('feed', e);
        }
    }

    // One physical line. Accepts both SSE `data: {...}` and bare NDJSON `{...}`,
    // because not every chatgpt.com endpoint uses the same framing.
    function feedLine(line, prio, source) {
        try {
            if (!line) return;
            diag.streamStats.lines++;
            var payload;
            if (line.indexOf('data:') === 0) {
                diag.streamStats.dataLines++;
                payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') return;
            } else {
                var t = line.replace(/^[\s\u0000]+/, '');
                if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return;
                payload = t.trim();
            }
            diag.events++;
            try {
                apply(harvestObject(JSON.parse(payload)), prio, source);
            } catch (e) {
                diag.parseErrors++;
            }
        } catch (e) {
            fail('feedLine', e);
        }
    }

    function tapStream(res, prio, source) {
        try {
            if (!res || !res.body || typeof res.body.getReader !== 'function') {
                diag.note = 'no readable body on clone (opaque or single-use)';
                scheduleRender();
                return;
            }

            var reader = res.body.getReader();
            var dec = new TextDecoder('utf-8');
            var buf = '';
            diag.streams++;
            state.status = 'STREAMING';
            scheduleRender();

            (function pump() {
                reader.read().then(function (r) {
                    try {
                        diag.streamStats.chunks++;
                        if (r.value && r.value.byteLength) diag.streamStats.bytes += r.value.byteLength;
                        if (r.done) {
                            if (buf) { feed(buf, prio, source); buf = ''; }
                            state.status = 'CAPTURED';
                            note('stream closed after ' + diag.events + ' event(s)');
                            return;
                        }
                        buf += dec.decode(r.value, { stream: true });
                        var cut = buf.lastIndexOf('\n');
                        if (cut !== -1) {
                            var ready = buf.slice(0, cut + 1);
                            buf = buf.slice(cut + 1);
                            feed(ready, prio, source);
                        }
                        if (buf.length > MAX_BUFFER) {
                            feed(buf.slice(-MAX_SNIFF), prio, source);
                            buf = '';
                        }
                    } catch (e) {
                        fail('stream chunk', e);
                    }
                    pump();
                }).catch(function (e) {
                    state.status = 'STREAM ENDED';
                    // the page aborting its own stream (stop / navigate) is normal
                    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) {
                        try { console.log('[RI] stream aborted by page (normal)'); } catch (err) {}
                        scheduleRender();
                    } else {
                        fail('stream read', e);
                    }
                });
            })();
        } catch (e) {
            fail('tapStream', e);
        }
    }

    // Non-streaming JSON reply (defensive; the real endpoint is SSE).
    function tapJson(res, prio, source) {
        try {
            res.text().then(function (t) {
                try {
                    diag.streams++;
                    apply(harvestObject(JSON.parse(t)), prio, source);
                    apply(harvestText(t), prio, source);
                    state.status = 'CAPTURED';
                    scheduleRender();
                } catch (e) {
                    // not JSON (probably SSE with an unexpected content-type)
                    feed(t, prio, source);
                    state.status = 'CAPTURED';
                    scheduleRender();
                }
            }).catch(function (e) { fail('json read', e); });
        } catch (e) {
            fail('tapJson', e);
        }
    }

    // ------------------------------------------------------------------
    // 5. Request side
    // ------------------------------------------------------------------
    function startTurn() {
        try {
            state.turn++;
            fieldPrio = {};
            state.requestModel = null;
            state.assistantModel = null;
            state.resolvedModel = null;
            state.steModel = null;
            state.clusterRegion = null;
            state.planType = null;
            state.lastSeen = null;
            state.status = 'REQUEST SENT';
            showPanel();   // the panel only appears once a real turn starts
            scheduleRender();
        } catch (e) {
            fail('startTurn', e);
        }
    }

    function readModelFromBody(body, prio, source) {
        try {
            if (!body) return;
            var text = null;

            if (typeof body === 'string') {
                text = body;
            } else if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
                return;   // handled by teeBody() before the call is made
            } else if (W.URLSearchParams && body instanceof W.URLSearchParams) {
                var v = body.get('model');
                if (v) apply({ requestModel: v }, prio, source);
                return;
            } else if (W.FormData && body instanceof W.FormData) {
                var f = body.get('model');
                if (typeof f === 'string') apply({ requestModel: f }, prio, source);
                return;
            } else if (W.Blob && body instanceof W.Blob) {
                return;   // not worth the async round trip for a header value
            } else if (body instanceof ArrayBuffer || (W.ArrayBuffer && W.ArrayBuffer.isView && W.ArrayBuffer.isView(body))) {
                text = new TextDecoder('utf-8').decode(body);
            } else if (typeof body === 'object') {
                var m = body.model;
                if (typeof m === 'string' && m) { apply({ requestModel: m }, prio, source); return; }
            }

            if (!text) return;
            var mm = /"model"\s*:\s*"([^"\\]*)"/.exec(text);
            if (mm) apply({ requestModel: mm[1] }, prio, source);
        } catch (e) {
            fail('readModelFromBody', e);
        }
    }

    // ------------------------------------------------------------------
    // 6. Hooks
    // ------------------------------------------------------------------
    var nativeFetch = null;

    function urlOf(input) {
        try {
            if (typeof input === 'string') return input;
            if (input && typeof input.url === 'string') return input.url;
            return String(input);
        } catch (e) { return ''; }
    }

    function methodOf(init, input) {
        try { return String((init && init.method) || (input && input.method) || 'GET').toUpperCase(); }
        catch (e) { return 'GET'; }
    }

    function isTarget(url, method) {
        try {
            var u = String(url);
            if (TARGET_STRICT.test(u)) return true;
            return method === 'POST' && TARGET_LOOSE.test(u);
        } catch (e) { return false; }
    }

    // Path only (never the query string) plus a hit histogram, so the log never
    // carries ids that came back from the server.
    function pathOf(url) {
        try {
            var u = String(url);
            var q = u.indexOf('?');
            if (q !== -1) u = u.slice(0, q);
            var m = /^[a-z]+:\/\/[^\/]*(\/.*)$/i.exec(u);
            return m ? m[1] : u;
        } catch (e) { return '(unparsed)'; }
    }

    function noteTarget(url, method, body) {
        try {
            var p = pathOf(url);
            diag.lastPath = method + ' ' + p;
            diag.pathCounts[p] = (diag.pathCounts[p] || 0) + 1;
            if (p === TURN_PATH) diag.exactHits++;
            else diag.otherHits++;

            var kind = '(none)';
            if (body === undefined || body === null) kind = '(none)';
            else if (typeof body === 'string') kind = 'string';
            else if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) kind = 'ReadableStream';
            else if (typeof Blob !== 'undefined' && body instanceof Blob) kind = 'Blob';
            else if (typeof FormData !== 'undefined' && body instanceof FormData) kind = 'FormData';
            else if (body instanceof ArrayBuffer || (W.ArrayBuffer && W.ArrayBuffer.isView && W.ArrayBuffer.isView(body))) kind = 'ArrayBuffer';
            else kind = typeof body;
            diag.lastBodyKind = kind;
        } catch (e) {
            fail('noteTarget', e);
        }
    }

    function isTurnPath(url) { return pathOf(url) === TURN_PATH; }
    function isPreparePath(url) { return pathOf(url) === '/backend-api/f/conversation/prepare'; }

    // Unfiltered coverage counter. diag.pathCounts only ever sees paths that
    // already matched isTarget(), so it can never prove what else was called.
    // This one records EVERY /backend-api/* request, whatever the mode, so
    // "does Work/Codex use the same gateway?" becomes a measurement instead of
    // an inference. Path only - no query string, no body, no ids.
    function noteApiPath(url) {
        try {
            var p = pathOf(url);
            if (p.indexOf('/backend-api/') !== 0 && p.indexOf('/backend-api') !== 0) return;
            var keys = Object.keys(diag.allPaths);
            if (diag.allPaths[p] === undefined && keys.length >= 200) return;   // bounded
            diag.allPaths[p] = (diag.allPaths[p] || 0) + 1;
        } catch (e) { /* never fatal */ }
    }

    // Response priority per endpoint. Anything not listed is observed but never
    // harvested.
    //   2 = the real turn (authoritative, may overwrite anything)
    //   1 = the SAME turn's pre-flight (used only as a Request fallback)
    //   0 = observed and counted, never displayed
    //
    // /conversation/init and /conversations/batch are deliberately 0. Measured
    // over 339 snapshots: 241 of 590 displayed values came from those two, and
    // batch can carry OTHER conversations' metadata. Showing a foreign model
    // slug is worse than showing "waiting", so the panel now only ever shows
    // what THIS turn's own response stream exposed.
    function harvestPrio(url) {
        var p = pathOf(url);
        if (p === TURN_PATH) return 2;                                // the real turn
        if (p === '/backend-api/f/conversation/prepare') return 1;     // same turn, pre-flight
        return 0;
    }

    // A page may hand fetch a ReadableStream body. Tee it so we can read one
    // branch for the model slug while the page's branch is passed through
    // untouched. Returns the init to use for the real call.
    function teeBody(init) {
        try {
            if (!init || !init.body) return init;
            var b = init.body;
            if (!(typeof ReadableStream !== 'undefined' && b instanceof ReadableStream)) return init;
            if (typeof b.tee !== 'function') return init;

            var branches = b.tee();
            var copy = {};
            for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) copy[k] = init[k];
            copy.body = branches[0];

            var dec = new TextDecoder('utf-8');
            var acc = '';
            var reader = branches[1].getReader();
            (function drain() {
                reader.read().then(function (r) {
                    if (r.done) { readModelFromText(acc); return; }
                    if (acc.length < 400000) acc += dec.decode(r.value, { stream: true });
                    drain();
                }).catch(function () {});
            })();
            return copy;
        } catch (e) {
            fail('teeBody', e);
            return init;
        }
    }

    function readModelFromText(text) {
        try {
            if (!text) return;
            var mm = /"model"\s*:\s*"([^"\\]*)"/.exec(text);
            if (mm) apply({ requestModel: mm[1] });
        } catch (e) {
            fail('readModelFromText', e);
        }
    }

    function installFetch() {
        try {
            var orig = W.fetch;
            if (typeof orig !== 'function') { fail('installFetch', 'window.fetch is ' + typeof orig); return; }
            nativeFetch = orig;

            var hooked = function (input, init) {
                var self = this;
                var url = urlOf(input);
                var method = methodOf(init, input);
                var hit = false;
                var isTurn = false;
                var hp = 0;
                var source = pathOf(url);
                var callArgs = arguments;
                try {
                    diag.fetchCalls++;
                    noteApiPath(url);
                    hit = isTarget(url, method);
                    if (hit) {
                        diag.targetHits++;
                        noteTarget(url, method, (init && init.body) || (input && input.body));
                        isTurn = method === 'POST' && isTurnPath(url);
                        hp = harvestPrio(url);
                        if (method === 'POST' && isPreparePath(url)) {
                            // remember the model this turn is being prepared for
                            var pb = (init && init.body) || (input && input.body);
                            if (typeof pb === 'string') {
                                var pm = /"model"\s*:\s*"([^"\\]*)"/.exec(pb);
                                if (pm) diag.pendingReq = pm[1];
                            }
                        }
                        if (isTurn) {
                            startTurn();
                            var b = (init && init.body) || (input && input.body);
                            readModelFromBody(b, 2, TURN_PATH);
                            // the turn body is often an unreadable stream; fall back
                            // to the model the client declared during prepare
                            if (!state.requestModel && diag.pendingReq) {
                                apply({ requestModel: diag.pendingReq }, 2, TURN_PATH);
                            }
                            init = teeBody(init);
                            callArgs = [input, init];
                            note('turn POST detected');
                        }
                    }
                } catch (e) { fail('fetch pre', e); }

                var p;
                try {
                    p = orig.apply(self, callArgs);
                } catch (e) {
                    fail('fetch call', e);
                    throw e;
                }

                if (!hit || !hp || !p || typeof p.then !== 'function') return p;

                return p.then(function (res) {
                    try {
                        var ctype = '';
                        try { ctype = String(res.headers.get('content-type') || ''); } catch (e) {}
                        diag.lastCtype = ctype || '(none)';
                        var clone = res.clone();
                        var prio = hp;
                        if (/event-stream/i.test(ctype)) tapStream(clone, prio, source);
                        else tapJson(clone, prio, source);
                    } catch (e) {
                        fail('res.clone()', e);
                    }
                    return res;   // the page's own Response, untouched
                }, function (err) {
                    try {
                        state.status = 'REQUEST FAILED';
                        // the page cancelling its own request is routine
                        if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)))) {
                            state.status = 'ABORTED BY PAGE';
                            try { console.log('[RI] page aborted its own request (normal)'); } catch (e2) {}
                            scheduleRender();
                        } else {
                            fail('fetch rejected', err);
                        }
                    } catch (e) {}
                    throw err;
                });
            };

            W.fetch = hooked;
            diag.fetchHooked = true;
            diag.pageCtx = (W === window);
            note('fetch hook installed');
        } catch (e) {
            fail('installFetch', e);
        }
    }

    function installXhr() {
        try {
            var X = W.XMLHttpRequest;
            if (!X || !X.prototype || typeof X.prototype.open !== 'function') return;
            var XP = X.prototype;
            var rawOpen = XP.open;
            var rawSend = XP.send;

            XP.open = function (method, url) {
                try {
                    noteApiPath(url);
                    this.__riUrl = url;
                    this.__riMethod = String(method || 'GET').toUpperCase();
                } catch (e) { fail('xhr open', e); }
                return rawOpen.apply(this, arguments);
            };

            XP.send = function (body) {
                var xhr = this;
                var src = pathOf(xhr.__riUrl);
                try {
                    if (isTarget(xhr.__riUrl, xhr.__riMethod)) {
                        diag.targetHits++;
                        var turn = xhr.__riMethod === 'POST' && isTurnPath(xhr.__riUrl);
                        var hp = harvestPrio(xhr.__riUrl);
                        if (turn) {
                            startTurn();
                            readModelFromBody(body, 2, TURN_PATH);
                            if (!state.requestModel && diag.pendingReq) {
                                apply({ requestModel: diag.pendingReq }, 2, TURN_PATH);
                            }
                        }
                        if (hp) xhr.addEventListener('load', function () {
                            try {
                                var t = xhr.responseText;
                                if (typeof t === 'string' && t) {
                                    diag.streams++;
                                    feed(t, hp, src);
                                    state.status = 'CAPTURED';
                                    scheduleRender();
                                }
                            } catch (e) { fail('xhr response', e); }
                        });
                    }
                } catch (e) { fail('xhr send', e); }
                return rawSend.apply(this, arguments);
            };

            diag.xhrHooked = true;
        } catch (e) {
            fail('installXhr', e);
        }
    }

    // Some builds push the stream over EventSource instead of fetch.
    function installEventSource() {
        try {
            var ES = W.EventSource;
            if (typeof ES !== 'function') return;
            var Wrap = function (url, cfg) {
                var self = new ES(url, cfg);
                try {
                    if (isTarget(url, 'GET')) {
                        diag.targetHits++;
                        noteTarget(url, 'GET', null);
                        var esp = harvestPrio(url);
                        if (!esp) return self;
                        self.addEventListener('message', function (ev) {
                            try {
                                if (typeof ev.data === 'string' && ev.data) {
                                    diag.streams++;
                                    feedLine('data: ' + ev.data, esp, pathOf(url));
                                }
                            } catch (e) { fail('es message', e); }
                        });
                    }
                } catch (e) { fail('event source', e); }
                return self;
            };
            Wrap.prototype = ES.prototype;
            W.EventSource = Wrap;
            diag.esHooked = true;
        } catch (e) {
            fail('installEventSource', e);
        }
    }

    // ------------------------------------------------------------------
    // 7. Boot
    // ------------------------------------------------------------------
    diag.started = true;
    diag.pageCtx = (W === window);

    // Surface our own uncaught errors on the panel, and only ours.
    try {
        if (typeof W.addEventListener === 'function') {
            W.addEventListener('error', function (e) {
                try {
                    if (e && typeof e.filename === 'string' && e.filename.indexOf('userscript') !== -1) {
                        fail('uncaught', e.message + ' @line ' + e.lineno);
                    }
                } catch (err) {}
            });
        }
    } catch (e) { /* never fatal */ }

    function boot() {
        try {
            mount('boot');

            try {
                var mo = new MutationObserver(function () {
                    try {
                        toBody();
                        if (!diag.mounted) mount('observer');
                    } catch (e) { fail('observer cb', e); }
                });
                mo.observe(D.documentElement || D, { childList: true, subtree: true });
            } catch (e) {
                fail('observer', e);
            }

            D.addEventListener('readystatechange', function () { mount('readyState:' + D.readyState); });
            setTimeout(function () { toBody(); mount('t=250'); }, 250);
            setTimeout(function () { toBody(); mount('t=1200'); }, 1200);
            setTimeout(function () { toBody(); mount('t=3500'); }, 3500);

            installFetch();
            installXhr();
            installEventSource();

            // Escape hatch for manual inspection without DevTools gymnastics:
            //   __RI__.dump()   /   __RI__.state   /   __RI__.diag
            try {
                W.__RI__ = {
                    version: VERSION,
                    state: state,
                    diag: diag,
                    ui: ui,
                    show: showPanel,
                    hide: hidePanel,
                    close: closePanel,
                    dump: function () { return JSON.stringify({ version: VERSION, state: state, ui: ui, diag: diag }, null, 2); }
                };
            } catch (e) { fail('expose', e); }

            state.status = 'READY';
            note('script started v' + VERSION +
                ' top=' + (isTopFrame() ? 'yes' : 'no') +
                ' ctx=' + (diag.pageCtx ? 'page' : 'sandbox') +
                ' href=' + W.location.href);
        } catch (e) {
            fail('boot', e);
        }
    }

    boot();
})();

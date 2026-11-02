'use strict';
/**
 * Claude (claude.ai web) transport, merged into the same pool as DeepSeek.
 *
 * The gateway has one internal shape: a caller hands over a prompt and gets back a
 * stream of DeepSeek `data: {...}` frames, which server.js already understands —
 * fragments, `response/content`, `response/finish_reason`, `response_message_id`.
 * This module speaks claude.ai's side of that contract and nothing else:
 *
 *   GET  /api/organizations
 *   POST /api/organizations/{org}/chat_conversations
 *   POST /api/organizations/{org}/chat_conversations/{conv}/completion   (SSE)
 *
 * and turns its Messages-style SSE (`message_start`, `content_block_delta` with
 * `text_delta` / `thinking_delta`, `message_delta`, `message_stop`, plus the older
 * `{"completion": "…"}` frames) into those.
 *
 * Everything is per-login: a Claude account is a cookie jar (`sessionKey` plus
 * whatever Cloudflare put in it), conversations belong to that login, and
 * parent_message_uuid is how a turn continues — which is exactly the
 * one-chat-per-agent rule the gateway already enforces for DeepSeek.
 *
 * A Claude login is recognised by `provider: "claude"` in its auth file, or by a
 * `sessionKey` cookie with no DeepSeek token. Nothing here guesses by filename.
 */

const crypto = require('crypto');

const PROVIDER = 'claude';
// claude.ai's first message in a conversation hangs off the root; later turns hang
// off the assistant message uuid the stream handed back in `message_start`.
const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000';

// The web models, by the id an agent asks for. `web` is what claude.ai expects in
// the completion body; the gateway id stays stable so an agent config never has to
// know a release date.
const MODELS = {
    'claude-sonnet-4-5': { web: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (web)', thinking: true },
    'claude-opus-4-1': { web: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1 (web)', thinking: true },
    'claude-haiku-4-5': { web: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (web)', thinking: false },
};
const ALIASES = {
    sonnet: 'claude-sonnet-4-5',
    opus: 'claude-opus-4-1',
    haiku: 'claude-haiku-4-5',
    'claude-sonnet': 'claude-sonnet-4-5',
    'claude-opus': 'claude-opus-4-1',
    'claude-haiku': 'claude-haiku-4-5',
};

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_TZ = process.env.CLAUDE_TIMEZONE || 'Europe/London';
const CLIENT_PLATFORM = 'web_claude_ai';
const CLIENT_VERSION = process.env.CLAUDE_CLIENT_VERSION || '1.0.0';

function baseUrl(env = process.env) {
    return String(env.CLAUDE_BASE_URL || 'https://claude.ai').replace(/\/+$/, '');
}

class ClaudeWebError extends Error {
    constructor(message, { status = 502, type = 'upstream_error', retryAfter = null, body = '' } = {}) {
        super(message);
        this.name = 'ClaudeWebError';
        this.status = status;
        this.type = type;
        this.retryAfter = retryAfter;
        this.body = body;
    }
}

// ---------- auth files ----------

function cookieHeader(config = {}) {
    if (typeof config.cookie === 'string' && config.cookie.trim()) return config.cookie.trim();
    if (Array.isArray(config.cookies)) {
        return config.cookies
            .filter(c => c && c.name && c.value)
            .map(c => `${String(c.name).trim()}=${String(c.value).trim()}`)
            .join('; ');
    }
    return '';
}

function hasCredentials(config = {}) {
    return Boolean(cookieHeader(config));
}

// `provider: "claude"` is the explicit switch. A bare Claude cookie jar (a
// `sessionKey=` cookie and no DeepSeek token) is the other way in, so an export
// from the browser works without being edited first.
function detectProvider(config = {}) {
    const declared = String(config.provider || config.api || '').toLowerCase().trim();
    if (declared === 'claude' || declared === 'anthropic') return PROVIDER;
    if (declared === 'deepseek') return 'deepseek';
    if (config.token) return 'deepseek';
    const cookie = cookieHeader(config);
    if (/(^|;\s*)sessionKey=/.test(cookie)) return PROVIDER;
    if (config.claude && typeof config.claude === 'object') return PROVIDER;
    return 'deepseek';
}

function normalizeConfig(config = {}) {
    if (detectProvider(config) !== PROVIDER) return config;
    config.provider = PROVIDER;
    config.cookie = cookieHeader(config);
    delete config.cookies;
    config.org = String(config.org || config.organization || config.organization_uuid || '').trim();
    config.model = resolveModel(config.model).gateway;
    return config;
}

function buildHeaders(config = {}) {
    const headers = {
        'User-Agent': config.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/event-stream',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': baseUrl(),
        'Referer': `${baseUrl()}/new`,
        'anthropic-client-platform': CLIENT_PLATFORM,
        'anthropic-client-version': CLIENT_VERSION,
        'Cookie': config.cookie || '',
    };
    // A Cloudflare clearance cookie is already inside `cookie`; the header only
    // matters for a caller that keeps it separately.
    if (config.cf_clearance && !/(^|;\s*)cf_clearance=/.test(headers.Cookie)) {
        headers.Cookie = `${headers.Cookie}; cf_clearance=${config.cf_clearance}`.replace(/^;\s*/, '');
    }
    return headers;
}

// ---------- model ids ----------

function lookLikeClaudeId(id) {
    return /^claude[-_. ][a-z0-9._-]+$/.test(id) || /\b(opus|sonnet|haiku)\b/.test(id);
}

// Accepts anything an agent sends: `sonnet`, `claude-sonnet-4-5`,
// `anthropic/claude-opus-4-1`, `claude-opus-4-1[1m]`, or a dated id claude.ai
// knows that this build has not been updated for.
function resolveModel(name) {
    let id = String(name || DEFAULT_MODEL).toLowerCase().trim();
    id = id.replace(/^(anthropic|claude)\//, '').replace(/\[(?:1m|max|high|low)\]$/, '');
    const gateway = MODELS[id] ? id : (ALIASES[id] || id);
    const known = MODELS[gateway];
    if (known) return { gateway, web: known.web, label: known.label, thinking: known.thinking };
    // An unknown dated id is forwarded as-is: claude.ai accepts its own ids, and
    // refusing here would only break agents that ship a newer one.
    return { gateway, web: id, label: `${id} (web)`, thinking: true };
}

function isClaudeModel(name) {
    const raw = String(name || '').toLowerCase().trim();
    if (raw.startsWith('claude/') || raw.startsWith('anthropic/')) return true;
    const id = raw.replace(/^(anthropic|claude)\//, '').replace(/\[(?:1m|max|high|low)\]$/, '');
    if (MODELS[id] || ALIASES[id]) return true;
    return lookLikeClaudeId(id);
}

// ---------- http ----------

function classifyStatus(status, body = '', retryAfterHeader = null) {
    const text = String(body || '');
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) || null : null;
    if (status === 401 || /authentication_error|invalid_?api_?key|session (has )?expired/i.test(text)) {
        return { status: 401, type: 'authentication_error', retryAfter: null };
    }
    if (status === 403 && /just a moment|cf-chl|cloudflare|captcha/i.test(text)) {
        return { status: 403, type: 'waf_blocked', retryAfter: null };
    }
    if (status === 403) return { status: 403, type: 'forbidden', retryAfter: null };
    if (status === 429) return { status: 429, type: 'rate_limit_error', retryAfter: retryAfter || 30 };
    if (status === 404) return { status: 404, type: 'not_found', retryAfter: null };
    if (status >= 500) return { status, type: 'upstream_error', retryAfter };
    return { status, type: 'request_error', retryAfter };
}

function clip(text, max = 200) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ---------- curl-impersonate transport ----------
// claude.ai sits behind Cloudflare bot management, and `cf_clearance` is bound to the TLS
// fingerprint that earned it. Node's OpenSSL hello does not look like Chrome's, so every
// request from fetch() gets a 403 "Just a moment…" challenge even with a perfectly valid
// cookie jar. curl-impersonate sends Chrome's actual ClientHello, which passes — verified
// against a real login: the same cookie returns 200 there and 403 from fetch.
//
// CLAUDE_CURL_BIN pins a binary; CLAUDE_TRANSPORT=node turns this off (useful in tests).
// The fetch this module was loaded with. A test (or a caller) that installs its own fetch
// must keep using it: the impersonating transport is only for real upstream traffic.
const NATIVE_FETCH = globalThis.fetch;

const CURL_CANDIDATES = [
    process.env.CLAUDE_CURL_BIN,
    'curl_chrome124', 'curl_chrome116', 'curl_chrome110', 'curl-impersonate',
].filter(Boolean);

function curlBinary() {
    if (String(process.env.CLAUDE_TRANSPORT || '').toLowerCase() === 'node') return null;
    if (globalThis.fetch !== NATIVE_FETCH) return null;
    if (curlBinary.resolved !== undefined) return curlBinary.resolved;
    const { spawnSync } = require('child_process');
    curlBinary.resolved = null;
    for (const candidate of CURL_CANDIDATES) {
        const probe = spawnSync(candidate, ['--version'], { timeout: 4000, stdio: 'ignore' });
        if (probe.status === 0) { curlBinary.resolved = candidate; break; }
    }
    return curlBinary.resolved;
}

// Run one request through curl-impersonate. `--dump-header -` writes the response headers
// first, so the status is known before the body arrives and an SSE stream can start as
// soon as the first chunk lands.
function curlRequest(url, { method = 'GET', headers = {}, body = null, signal } = {}) {
    const bin = curlBinary();
    if (!bin) return null;
    const { spawn } = require('child_process');
    const args = ['-s', '-N', '--max-time', '600', '--connect-timeout', '20', '-D', '-', '-X', method];
    for (const [name, value] of Object.entries(headers || {})) {
        if (value == null || value === '') continue;
        args.push('-H', `${name}: ${value}`);
    }
    if (body != null) {
        args.push('--data-binary', '@-');
    }
    args.push(url);

    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    if (body != null) child.stdin.end(body);
    else child.stdin.end();

    const encoder = new TextEncoder();
    let status = 0;
    let headerText = '';
    let statusResolve;
    const statusReady = new Promise((resolve) => { statusResolve = resolve; });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }

    const bodyStream = new ReadableStream({
        start(controller) {
            let rest = Buffer.alloc(0);
            let headersDone = false;
            const flush = () => {
                if (rest.length) { controller.enqueue(encoder.encode(rest.toString('utf8'))); rest = Buffer.alloc(0); }
            };
            child.stdout.on('data', (chunk) => {
                if (headersDone) { controller.enqueue(encoder.encode(chunk.toString('utf8'))); return; }
                rest = Buffer.concat([rest, chunk]);
                const idx = rest.indexOf('\r\n\r\n');
                if (idx === -1) return;
                headerText += rest.subarray(0, idx).toString('utf8');
                rest = rest.subarray(idx + 4);
                headersDone = true;
                const match = /^HTTP\/[\d.]+\s+(\d{3})/.exec(headerText.trim());
                status = match ? Number(match[1]) : 0;
                statusResolve(status);
                flush();
            });
            let stderr = '';
            child.stderr.on('data', (d) => { if (stderr.length < 800) stderr += d.toString('utf8'); });
            child.on('error', (e) => {
                statusResolve(0);
                controller.error(new ClaudeWebError(`curl-impersonate failed: ${e.message}`, { status: 502, type: 'upstream_error' }));
            });
            child.on('close', (code) => {
                if (!headersDone) statusResolve(0);
                if (code !== 0 && !headersDone) {
                    controller.error(new ClaudeWebError(`curl-impersonate exited ${code}: ${clip(stderr, 200)}`, { status: 502, type: 'upstream_error' }));
                    return;
                }
                try { flush(); } catch { /* the reader went away */ }
                try { controller.close(); } catch { /* already closed */ }
                if (signal) signal.removeEventListener?.('abort', onAbort);
            });
        },
    });

    return { statusReady, bodyStream };
}

async function request(url, { method = 'GET', headers, body, signal, fetchImpl } = {}) {
    // Only the built-in fetch is replaced; a caller that passes fetchImpl (every test) keeps
    // the plain path, so the impersonating transport never leaks into a unit test.
    if (!fetchImpl) {
        const curl = curlRequest(url, { method, headers, body, signal });
        if (curl) {
            const status = await curl.statusReady;
            const text = await new Response(curl.bodyStream).text();
            if (status >= 200 && status < 300) {
                return new Response(text, { status, headers: { 'content-type': 'application/json' } });
            }
            const info = classifyStatus(status, text);
            throw new ClaudeWebError(`Claude answered HTTP ${status}: ${clip(text)}`, {
                status: info.status, type: info.type, retryAfter: info.retryAfter, body: text,
            });
        }
    }
    const doFetch = fetchImpl || globalThis.fetch;
    let resp;
    try {
        resp = await doFetch(url, { method, headers, body, signal });
    } catch (error) {
        // A cookie jar behind a dead proxy or an aborted client is not an auth problem.
        throw new ClaudeWebError(`Claude request failed: ${error?.message || 'network error'}`, {
            status: 502, type: 'upstream_error',
        });
    }
    if (resp.ok) return resp;
    let text = '';
    try { text = await resp.text(); } catch { /* body already gone; status is enough */ }
    const info = classifyStatus(resp.status, text, resp.headers?.get?.('retry-after'));
    throw new ClaudeWebError(`Claude answered HTTP ${resp.status}: ${clip(text)}`, {
        status: info.status, type: info.type, retryAfter: info.retryAfter, body: text,
    });
}

// The organisation uuid is stable per login, so it is discovered once and kept on
// the account object rather than on every request.
async function listOrganizations(config, options = {}) {
    const resp = await request(`${baseUrl(options.env)}/api/organizations`, {
        headers: buildHeaders(config), signal: options.signal, fetchImpl: options.fetchImpl,
    });
    let list;
    try { list = await resp.json(); } catch {
        throw new ClaudeWebError('Claude returned a non-JSON organisation list', { status: 502, type: 'upstream_error' });
    }
    if (!Array.isArray(list)) list = Array.isArray(list?.organizations) ? list.organizations : [];
    return list.filter(org => org && typeof org === 'object' && (org.uuid || org.id));
}

function pickOrganization(list = []) {
    if (!list.length) return null;
    const canChat = list.find(org => {
        const caps = org.capabilities;
        if (Array.isArray(caps)) return caps.includes('chat');
        return Boolean(caps?.chat);
    });
    return canChat || list[0];
}

async function resolveOrganization(config, options = {}) {
    if (config.org) return config.org;
    const list = await listOrganizations(config, options);
    const org = pickOrganization(list);
    if (!org) {
        throw new ClaudeWebError(
            'This Claude login belongs to no organisation, so it cannot start a chat. Sign in at claude.ai once, then re-import the cookie.',
            { status: 401, type: 'authentication_error' },
        );
    }
    return org.uuid || org.id;
}

// One login checked the same way the first turn checks it: an organisation list is
// what a working claude.ai session can always answer, and it costs no generation quota.
// Returns one verdict shape for the pool tooling, the health loop and the importer.
async function probeLogin(config = {}, { timeoutMs = 15000, signal, fetchImpl, env } = {}) {
    const started = Date.now();
    try {
        const list = await listOrganizations(config, {
            signal: signal || AbortSignal.timeout(timeoutMs),
            fetchImpl,
            env,
        });
        const org = pickOrganization(list);
        if (!org) {
            return {
                ok: false, kind: 'auth', status: 200, latencyMs: Date.now() - started, org: null,
                detail: 'this login belongs to no organisation',
            };
        }
        return {
            ok: true, kind: 'ok', status: 200, latencyMs: Date.now() - started,
            org: String(org.uuid || org.id), detail: '',
        };
    } catch (error) {
        const status = Number(error?.status) || 0;
        // A Cloudflare challenge is not a rejected login. claude.ai answers 403
        // "Just a moment…" to a jar it holds no clearance for, and calling that
        // `auth` marks a perfectly good cookie `needs_auth` for an hour — the login
        // is fine, the request just did not look like a browser. Report it as `waf`
        // so the pool retries instead of demanding a re-capture.
        const classified = classifyStatus(status, error?.body || error?.message || '', error?.retryAfter ? String(error.retryAfter) : null);
        const waf = classified.type === 'waf_blocked';
        const kind = waf ? 'waf'
            : status === 401 || status === 403 ? 'auth'
                : status === 429 ? 'ratelimit'
                    : status === 0 ? 'network' : 'upstream';
        return {
            ok: false, kind, status, latencyMs: Date.now() - started, org: null,
            retryAfterSec: error?.retryAfter || null,
            detail: String(error?.message || 'probe failed'), waf,
        };
    }
}

async function createConversation(config, org, options = {}) {
    const resp = await request(`${baseUrl(options.env)}/api/organizations/${encodeURIComponent(org)}/chat_conversations`, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify({ name: '', uuid: crypto.randomUUID() }),
        signal: options.signal,
        fetchImpl: options.fetchImpl,
    });
    let json;
    try { json = await resp.json(); } catch {
        throw new ClaudeWebError('Claude returned a non-JSON conversation', { status: 502, type: 'upstream_error' });
    }
    const uuid = json?.uuid || json?.conversation?.uuid || json?.id;
    if (!uuid) {
        throw new ClaudeWebError('Claude created a conversation without a uuid', { status: 502, type: 'upstream_error' });
    }
    return uuid;
}

// ---------- stream translation ----------

function frame(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`;
}

function finishReasonFor(stopReason) {
    switch (String(stopReason || '').toLowerCase()) {
        case 'max_tokens': return 'length';
        case 'tool_use': return 'tool_calls';
        case 'refusal': return 'content_filter';
        case 'end_turn':
        case 'stop_sequence':
        case 'stop':
            return 'stop';
        default:
            return 'stop';
    }
}

/**
 * Turn one Claude SSE event into DeepSeek frames, mutating `state` as it goes.
 * `state.seenFinish` lets the stream still end cleanly when claude.ai closes
 * without a `message_stop` (it does on some aborts).
 */
function translateEvent(event, state) {
    if (!event || typeof event !== 'object') return '';
    const type = event.type;

    if (type === 'message_start') {
        const uuid = event.message?.uuid || event.message?.id || null;
        if (uuid) {
            state.messageUuid = uuid;
            if (!state.sawMessageId) {
                state.sawMessageId = true;
                return frame({ response_message_id: uuid });
            }
        }
        return '';
    }

    // A block can open with text already in it (tool blocks and some older builds
    // stream the first words here rather than in a delta).
    if (type === 'content_block_start') {
        const block = event.content_block || {};
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            return frame({ p: 'response/content', v: block.text });
        }
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            return frame({ p: 'response/fragments', v: { type: 'THINK', content: block.thinking } });
        }
        return '';
    }

    if (type === 'content_block_delta') {
        const delta = event.delta || {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            return frame({ p: 'response/content', v: delta.text });
        }
        // `signature_delta` carries an opaque verifier, not prose: rendering it would
        // put base64 in the answer.
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
            return frame({ p: 'response/fragments', v: { type: 'THINK', content: delta.thinking } });
        }
        return '';
    }

    if (type === 'message_delta') {
        const stop = event.delta?.stop_reason;
        if (stop) {
            state.finishReason = finishReasonFor(stop);
            return frame({ p: 'response/finish_reason', v: state.finishReason });
        }
        return '';
    }

    if (type === 'message_stop') {
        state.finished = true;
        return frame({ p: 'response/status', v: 'FINISHED' });
    }

    if (type === 'error') {
        const message = event.error?.message || event.error?.type || event.message || 'Claude stream error';
        state.finished = true;
        state.error = message;
        return frame({ type: 'error', content: message });
    }

    // Older claude.ai web builds streamed plain continuation frames.
    if (typeof event.completion === 'string' && event.completion) {
        return frame({ p: 'response/content', v: event.completion });
    }
    if (typeof event.delta === 'string' && event.delta) {
        return frame({ p: 'response/content', v: event.delta });
    }
    return '';
}

/**
 * Wrap a Claude SSE body in a ReadableStream of DeepSeek frames.
 * Pure translation: no calls, no state outside the closure.
 */
function translateStream(body, { onError } = {}) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state = { messageUuid: null, sawMessageId: false, finishReason: null, finished: false, error: null };
    let buffer = '';
    let closed = false;

    const handleLine = (line, controller) => {
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        let event;
        try { event = JSON.parse(raw); } catch { return; }
        const out = translateEvent(event, state);
        if (out) controller.enqueue(encoder.encode(out));
    };

    return new ReadableStream({
        async start(controller) {
            const finish = () => {
                if (closed) return;
                closed = true;
                if (!state.finishReason) {
                    const reason = state.error ? 'error' : 'stop';
                    controller.enqueue(encoder.encode(frame({ p: 'response/finish_reason', v: reason })));
                }
                if (!state.finished) controller.enqueue(encoder.encode(frame({ p: 'response/status', v: 'FINISHED' })));
                controller.close();
            };
            try {
                for await (const chunk of body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) handleLine(line.trimEnd(), controller);
                }
                buffer += decoder.decode();
                if (buffer) handleLine(buffer.trimEnd(), controller);
                finish();
            } catch (error) {
                if (typeof onError === 'function') onError(error);
                finish();
            }
        },
    });
}

async function completeStream({ config, org, conversationId, parentMessageUuid, prompt, model, timezone, signal, fetchImpl, env }) {
    const resolved = resolveModel(model);
    const url = `${baseUrl(env)}/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(conversationId)}/completion`;
    const payload = JSON.stringify({
        prompt,
        timezone: timezone || DEFAULT_TZ,
        model: resolved.web,
        attachments: [],
        files: [],
        rendering_mode: 'messages',
        parent_message_uuid: parentMessageUuid || ROOT_MESSAGE_UUID,
    });
    const streamHeaders = { ...buildHeaders(config), Accept: 'text/event-stream' };
    // Streaming through curl-impersonate: the body must stay a live stream, so it is not
    // buffered the way request() buffers a JSON answer.
    if (!fetchImpl) {
        const curl = curlRequest(url, { method: 'POST', headers: streamHeaders, body: payload, signal });
        if (curl) {
            const status = await curl.statusReady;
            if (status < 200 || status >= 300) {
                const text = await new Response(curl.bodyStream).text();
                const info = classifyStatus(status, text);
                throw new ClaudeWebError(`Claude answered HTTP ${status}: ${clip(text)}`, {
                    status: info.status, type: info.type, retryAfter: info.retryAfter, body: text,
                });
            }
            return { resp: { ok: true, status }, model: resolved, stream: translateStream(curl.bodyStream) };
        }
    }
    const resp = await request(url, {
        method: 'POST',
        headers: streamHeaders,
        body: payload,
        signal,
        fetchImpl,
    });
    if (!resp.body) {
        throw new ClaudeWebError('Claude accepted the prompt but returned no stream', { status: 502, type: 'upstream_error' });
    }
    return { resp, model: resolved, stream: translateStream(resp.body) };
}

module.exports = {
    PROVIDER,
    ROOT_MESSAGE_UUID,
    MODELS,
    curlBinary,
    curlRequest,
    DEFAULT_MODEL,
    baseUrl,
    ClaudeWebError,
    detectProvider,
    normalizeConfig,
    hasCredentials,
    buildHeaders,
    cookieHeader,
    listOrganizations,
    pickOrganization,
    resolveOrganization,
    probeLogin,
    createConversation,
    completeStream,
    translateEvent,
    translateStream,
    classifyStatus,
    finishReasonFor,
    resolveModel,
    isClaudeModel,
};

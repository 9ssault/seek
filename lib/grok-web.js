'use strict';
/**
 * Grok (grok.com web) transport, the third upstream beside DeepSeek and Claude.
 *
 * Same contract as lib/claude-web.js: a caller hands over a prompt and gets back a
 * stream of DeepSeek `data: {...}` frames, which server.js already understands
 * (`response/content`, `response/fragments`, `response/finish_reason`,
 * `response_message_id`, `response/status`). This module speaks grok.com's side of
 * that contract and nothing else:
 *
 *   GET  /api/auth/session                                    (login probe)
 *   POST /rest/app-chat/conversations/new                     (SSE)
 *   POST /rest/app-chat/conversations/{id}/responses          (SSE, continuing turn)
 *
 * A Grok login is a cookie jar: `sso` / `sso-rw` are the session cookies, and the
 * Cloudflare cookies (`__cf_bm`, `cf_clearance`) come along with them. There is no
 * bearer token, exactly like claude.ai.
 *
 * The web stream shape is `{"result":{"response":{"token":"…"}}}` per chunk, with
 * the first frame sometimes carrying a whole `fullMessage`. The parser accepts the
 * documented shape plus the tolerated variants (bare `token`, `message`, plain
 * text frames), because a web build that renames a field must not empty an answer.
 *
 * NOTE ON VERIFICATION: this transport was written from the web client's request
 * shape and is exercised against a mocked upstream in tests/grok-provider.test.js.
 * No grok.com login was available to confirm it end to end, and the module says so
 * rather than pretending otherwise: `code` is a real implementation, not a stub,
 * and every failure names what the upstream actually answered.
 */

const crypto = require('crypto');

const PROVIDER = 'grok';

// The web models, by the id an agent asks for. `web` is what grok.com expects in
// the request body; the gateway id stays stable so an agent config never has to
// know a release date.
const MODELS = {
    'grok-4': { web: 'grok-4', label: 'Grok 4 (web)', thinking: true },
    'grok-4-fast': { web: 'grok-4-fast', label: 'Grok 4 Fast (web)', thinking: false },
    'grok-3': { web: 'grok-3', label: 'Grok 3 (web)', thinking: false },
    'grok-code-fast-1': { web: 'grok-code-fast-1', label: 'Grok Code Fast 1 (web)', thinking: false },
};
const ALIASES = {
    grok: 'grok-4',
    'grok-latest': 'grok-4',
    'grok-4-latest': 'grok-4',
    'grok-fast': 'grok-4-fast',
};

const DEFAULT_MODEL = 'grok-4';
const DEFAULT_TZ = process.env.GROK_TIMEZONE || 'Europe/London';
const CLIENT_PLATFORM = 'web';
const CLIENT_VERSION = process.env.GROK_CLIENT_VERSION || '1.0.0';

function baseUrl(env = process.env) {
    return String(env.GROK_BASE_URL || 'https://grok.com').replace(/\/+$/, '');
}

class GrokWebError extends Error {
    constructor(message, { status = 502, type = 'upstream_error', retryAfter = null, body = '' } = {}) {
        super(message);
        this.name = 'GrokWebError';
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
    const cookie = cookieHeader(config);
    // `sso` is the grok.com session cookie; x.ai uses the same name on its own host.
    return /(^|;\s*)(?:sso|sso-rw)=/.test(cookie) || Boolean(config.token);
}

// `provider: "grok"` is the explicit switch. A bare grok.com jar (an `sso=` cookie
// and no DeepSeek token) is the other way in, so a browser export imports unedited.
function detectProvider(config = {}) {
    const declared = String(config.provider || config.api || '').toLowerCase().trim();
    if (declared === 'grok' || declared === 'xai' || declared === 'x.ai') return PROVIDER;
    if (declared === 'claude' || declared === 'anthropic') return 'claude';
    if (declared === 'deepseek') return 'deepseek';
    if (config.token) return 'deepseek';
    const cookie = cookieHeader(config);
    if (/(^|;\s*)(?:sso|sso-rw)=/.test(cookie)) return PROVIDER;
    if (/(^|;\s*)sessionKey=/.test(cookie)) return 'claude';
    return 'deepseek';
}

function normalizeConfig(config = {}) {
    if (detectProvider(config) !== PROVIDER) return config;
    config.provider = PROVIDER;
    config.cookie = cookieHeader(config);
    delete config.cookies;
    config.model = resolveModel(config.model).gateway;
    return config;
}

function buildHeaders(config = {}) {
    return {
        'User-Agent': config.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/event-stream',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': baseUrl(),
        'Referer': `${baseUrl()}/`,
        'Cookie': config.cookie || '',
    };
}

// ---------- model ids ----------

function lookLikeGrokId(id) {
    return /^grok[-_. ]?[a-z0-9._-]*$/.test(id);
}

function resolveModel(name) {
    let id = String(name || DEFAULT_MODEL).toLowerCase().trim();
    id = id.replace(/^(xai|x\.ai|grok)\//, '').replace(/\[(?:1m|max|high|low)\]$/, '');
    const gateway = MODELS[id] ? id : (ALIASES[id] || id);
    const known = MODELS[gateway];
    if (known) return { gateway, web: known.web, label: known.label, thinking: known.thinking };
    // An unknown id is forwarded as-is: grok.com accepts its own names, and refusing
    // here would only break an agent that ships a newer one.
    return { gateway, web: id, label: `${id} (web)`, thinking: true };
}

function isGrokModel(name) {
    const raw = String(name || '').toLowerCase().trim();
    if (raw.startsWith('xai/') || raw.startsWith('x.ai/') || raw.startsWith('grok/')) return true;
    const id = raw.replace(/^(xai|x\.ai|grok)\//, '').replace(/\[(?:1m|max|high|low)\]$/, '');
    if (MODELS[id] || ALIASES[id]) return true;
    return lookLikeGrokId(id);
}

// ---------- http ----------

function classifyStatus(status, body = '', retryAfterHeader = null) {
    const text = String(body || '');
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) || null : null;
    if (status === 401 || /unauthori[sz]ed|not authenticated|invalid token|session (has )?expired/i.test(text)) {
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

async function request(url, { method = 'GET', headers, body, signal, fetchImpl } = {}) {
    const doFetch = fetchImpl || globalThis.fetch;
    let resp;
    try {
        resp = await doFetch(url, { method, headers, body, signal });
    } catch (error) {
        throw new GrokWebError(`Grok request failed: ${error?.message || 'network error'}`, {
            status: 502, type: 'upstream_error',
        });
    }
    if (resp.ok) return resp;
    let text = '';
    try { text = await resp.text(); } catch { /* body already gone; status is enough */ }
    const info = classifyStatus(resp.status, text, resp.headers?.get?.('retry-after'));
    throw new GrokWebError(`Grok answered HTTP ${resp.status}: ${clip(text)}`, {
        status: info.status, type: info.type, retryAfter: info.retryAfter, body: text,
    });
}

// ---------- login ----------

// `GET /api/auth/session` is the cheapest question a signed-in grok.com tab can
// always answer: it returns the account object, costs no generation quota, and 401s
// on a dead jar. A non-JSON answer is reported as unverified rather than rejected —
// a build that moved the endpoint must not mark a good login dead.
async function probeLogin(config = {}, { timeoutMs = 15000, signal, fetchImpl, env } = {}) {
    const started = Date.now();
    if (!hasCredentials(config)) {
        return { ok: false, kind: 'auth', status: 0, latencyMs: 0, detail: 'no sso cookie in the jar' };
    }
    let resp;
    try {
        resp = await request(`${baseUrl(env)}/api/auth/session`, {
            headers: { ...buildHeaders(config), Accept: 'application/json' },
            signal: signal || AbortSignal.timeout(timeoutMs),
            fetchImpl,
        });
    } catch (error) {
        const status = Number(error?.status) || 0;
        const kind = status === 401 || status === 403 ? 'auth'
            : status === 429 ? 'ratelimit'
                : status === 0 ? 'network' : 'upstream';
        return {
            ok: false, kind, status, latencyMs: Date.now() - started, org: null,
            retryAfterSec: error?.retryAfter || null,
            detail: String(error?.message || 'probe failed'),
        };
    }
    let json = null;
    try { json = await resp.json(); } catch { json = null; }
    if (!json || typeof json !== 'object') {
        return {
            ok: true, kind: 'unverified', status: resp.status, latencyMs: Date.now() - started,
            detail: 'grok.com answered a non-JSON session document',
        };
    }
    if (json.user === null || json.authenticated === false) {
        return { ok: false, kind: 'auth', status: 401, latencyMs: Date.now() - started, detail: 'not signed in' };
    }
    return {
        ok: true, kind: 'ok', status: resp.status, latencyMs: Date.now() - started,
        account: clip(json.user?.email || json.user?.name || '', 80), detail: '',
    };
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
        default: return 'stop';
    }
}

/**
 * Turn one grok.com SSE event into DeepSeek frames, mutating `state` as it goes.
 * Tolerant on purpose: `result.response.token` is the documented shape, and a bare
 * `token` / `message` / plain-string frame is accepted so a renamed field still
 * produces an answer instead of silence.
 */
function translateEvent(event, state) {
    if (!event || typeof event !== 'object') {
        if (typeof event === 'string' && event) return frame({ p: 'response/content', v: event });
        return '';
    }
    const response = event.result?.response || event.response || event;

    const modelResponse = response.modelResponse || event.result?.modelResponse;
    if (modelResponse && typeof modelResponse === 'object') {
        // One frame can carry both the identity and the whole message, so both are
        // emitted rather than the first one returning and swallowing the text.
        const out = [];
        const uuid = modelResponse.responseId || modelResponse.id || modelResponse.conversationId;
        const conversation = modelResponse.conversationId || event.result?.conversation?.id;
        if (conversation) state.conversationId = conversation;
        if (uuid && !state.sawMessageId) {
            state.sawMessageId = true;
            state.messageUuid = uuid;
            out.push(frame({ response_message_id: uuid }));
        }
        const whole = modelResponse.message || modelResponse.fullMessage;
        if (typeof whole === 'string' && whole && !state.sawText) {
            state.sawText = true;
            out.push(frame({ p: 'response/content', v: whole }));
        }
        return out.join('');
    }

    const token = typeof response.token === 'string' ? response.token
        : typeof response.delta === 'string' ? response.delta
            : typeof response.message === 'string' ? response.message
                : typeof event.token === 'string' ? event.token : '';
    if (token) {
        state.sawText = true;
        return frame({ p: 'response/content', v: token });
    }

    const thinking = typeof response.thinking === 'string' ? response.thinking
        : typeof response.reasoning === 'string' ? response.reasoning : '';
    if (thinking) return frame({ p: 'response/fragments', v: { type: 'THINK', content: thinking } });

    if (response.stopReason || response.finishReason) {
        state.finishReason = finishReasonFor(response.stopReason || response.finishReason);
        return frame({ p: 'response/finish_reason', v: state.finishReason });
    }
    if (response.isHardStop === true || response.done === true) {
        state.finished = true;
        return frame({ p: 'response/status', v: 'FINISHED' });
    }
    if (event.error || response.error) {
        const message = event.error?.message || response.error?.message || event.error || response.error;
        state.finished = true;
        state.error = clip(message, 300);
        return frame({ type: 'error', content: state.error });
    }
    return '';
}

/**
 * Wrap a grok.com SSE body in a ReadableStream of DeepSeek frames.
 * Pure translation: no calls, no state outside the closure.
 */
function translateStream(body, { onError, onConversation } = {}) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state = { messageUuid: null, conversationId: null, sawMessageId: false, sawText: false, finishReason: null, finished: false, error: null };
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
        // Report the chat once: the caller opens an agent session on it and a repeat
        // would look like the session moved mid-stream.
        if (state.conversationId && state.reportedConversation !== state.conversationId) {
            state.reportedConversation = state.conversationId;
            if (typeof onConversation === 'function') onConversation(state.conversationId);
        }
    };

    return new ReadableStream({
        async start(controller) {
            const finish = () => {
                if (closed) return;
                closed = true;
                if (!state.finishReason) {
                    controller.enqueue(encoder.encode(frame({ p: 'response/finish_reason', v: state.error ? 'error' : 'stop' })));
                }
                if (!state.finished) controller.enqueue(encoder.encode(frame({ p: 'response/status', v: 'FINISHED' })));
                controller.close();
            };
            try {
                for await (const chunk of body) {
                    // A web stream yields Uint8Array, a plain Buffer yields bytes when its
                    // iterator is used, and a test fixture may hand over a string: accept all
                    // three rather than silently reading nothing.
                    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
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

// A new conversation carries the whole prompt; a continuing turn posts to the
// conversation's own /responses endpoint with just the new text.
async function completeStream({ config, conversationId, parentMessageUuid, prompt, model, timezone, signal, fetchImpl, env, onConversation }) {
    const resolved = resolveModel(model);
    const continuing = Boolean(conversationId);
    const url = continuing
        ? `${baseUrl(env)}/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/responses`
        : `${baseUrl(env)}/rest/app-chat/conversations/new`;
    const body = continuing
        ? { message: prompt, parentResponseId: parentMessageUuid || undefined, modelName: resolved.web, isReasoning: resolved.thinking }
        : { message: prompt, modelName: resolved.web, isReasoning: resolved.thinking, timezone: timezone || DEFAULT_TZ };
    const resp = await request(url, {
        method: 'POST',
        headers: { ...buildHeaders(config), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
        fetchImpl,
    });
    if (!resp.body) {
        throw new GrokWebError('Grok accepted the prompt but returned no stream', { status: 502, type: 'upstream_error' });
    }
    return { resp, model: resolved, stream: translateStream(resp.body, { onConversation }) };
}

function newConversationUuid() {
    return crypto.randomUUID();
}

module.exports = {
    PROVIDER,
    MODELS,
    DEFAULT_MODEL,
    baseUrl,
    GrokWebError,
    detectProvider,
    normalizeConfig,
    hasCredentials,
    buildHeaders,
    cookieHeader,
    probeLogin,
    completeStream,
    translateEvent,
    translateStream,
    classifyStatus,
    finishReasonFor,
    resolveModel,
    isGrokModel,
    newConversationUuid,
};

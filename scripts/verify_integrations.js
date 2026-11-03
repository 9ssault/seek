#!/usr/bin/env node
'use strict';

// Cross-checks the agent integrations against the proxy that is actually running:
// the model ids each config names, the context window it advertises, the base URL
// and key it sends, and whether the file on disk still matches what
// `npm run setup:agents` would write today.
//
//   node scripts/verify_integrations.js
//   node scripts/verify_integrations.js --base-url http://127.0.0.1:9655 --probe
//   node scripts/verify_integrations.js --offline --json
//
// Exit 0 when every check passes, 2 when something needs attention, 1 on a fatal error.
// Nothing is written: the plans come from setup-agents.js and only its `after` text is read.

const crypto = require('crypto');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Every model id that can appear in an agent config. The suffix group keeps
// `deepseek-v4-flash-thinking-nosearch` in one piece.
const MODEL_ID_RE = /\bdeepseek-v4(?:-[a-z0-9]+)*\b/g;
// Chars per token used to compare an advertised context window with the proxy's cut.
const CHARS_PER_TOKEN = 4;

function cliValue(args, name, fallback = null) {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const next = args[i + 1];
    return next && !next.startsWith('--') ? next : fallback;
}

function originOf(url) {
    try { return new URL(String(url).trim()).origin; } catch (err) { return null; }
}

function collectModelIds(text) {
    const ids = new Set();
    for (const match of String(text || '').match(MODEL_ID_RE) || []) ids.add(match);
    return [...ids];
}

// Pure: what one generated OpenCode config says versus what the proxy serves.
function checkOpencodeConfig(cfg, { models = [], baseUrl = null, apiKey = null, promptChars = 120000 } = {}) {
    const problems = [];
    const notes = [];
    const provider = cfg && cfg.provider && cfg.provider.freedeepseek;
    if (!provider || typeof provider !== 'object') {
        problems.push('no `provider.freedeepseek` entry — OpenCode will not see the proxy');
        return { problems, notes };
    }
    const options = provider.options || {};
    const target = originOf(baseUrl);
    const configured = originOf(options.baseURL);
    if (target && configured && target !== configured) {
        problems.push(`baseURL ${options.baseURL} is not the proxy at ${target}`);
    }
    if (apiKey && String(options.apiKey || '') !== String(apiKey)) {
        problems.push('apiKey does not match PROXY_API_KEY, so every request will answer 401');
    }
    const advertised = Object.keys(provider.models || {});
    const unknown = advertised.filter((id) => !models.includes(id));
    if (unknown.length && !models.length) {
        notes.push('could not compare model ids: the proxy did not report its list');
    } else if (unknown.length) {
        problems.push(`model(s) the proxy does not serve: ${unknown.join(', ')}`);
    }
    const unlisted = models.filter((id) => !advertised.includes(id));
    if (unlisted.length) notes.push(`not offered in OpenCode: ${unlisted.join(', ')}`);
    // The proxy cuts a prompt at `promptChars` characters before it sends it, so a
    // bigger advertised window just means OpenCode fills context that gets truncated.
    const honest = Math.max(8192, Math.floor(Number(promptChars) / CHARS_PER_TOKEN));
    for (const [id, model] of Object.entries(provider.models || {})) {
        const context = Number(model && model.limit && model.limit.context);
        if (Number.isFinite(context) && context > honest * 1.01) {
            problems.push(`${id} advertises ${context} tokens but the proxy cuts prompts at ${promptChars} chars (~${honest} tokens)`);
        }
    }
    const webOff = cfg.tools && cfg.tools.websearch === false && cfg.tools.webfetch === false;
    const denied = cfg.permission && cfg.permission.websearch === 'deny' && cfg.permission.webfetch === 'deny';
    if (!webOff || !denied) notes.push("OpenCode's own websearch/webfetch are still on; DeepSeek native search is already enabled");
    return { problems, notes };
}

async function fetchProxy(baseUrl, apiKey, { timeoutMs = 5000 } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const call = async (p) => {
        const res = await fetch(`${baseUrl}${p}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (err) { json = null; }
        return { status: res.status, json, text };
    };
    const health = await call('/health');
    if (health.status !== 200 || !health.json) {
        return { up: false, reason: `GET /health answered ${health.status}`, models: [], accounts: null, promptChars: null };
    }
    const h = health.json;
    // /v1/models is the source of truth: it carries the merged `seek` id and the Claude and
    // Grok ids, which the private health list does not. Fall back to health only when the
    // proxy answers without a list.
    let models = Array.isArray(h.models) ? h.models : [];
    const listed = await call('/v1/models');
    if (listed.json && Array.isArray(listed.json.data)) {
        const live = listed.json.data.map((m) => m && m.id).filter(Boolean);
        if (live.length) models = live;
    }
    return {
        up: true,
        models,
        accounts: Array.isArray(h.accounts) ? h.accounts : null,
        // The proxy reports its real prompt cut; only guess if an older build does not.
        promptChars: Number(h.prompt_chars) || Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS) || 120000,
        status: h.status,
    };
}

async function probeCompletion(baseUrl, apiKey, model) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const started = Date.now();
    try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word ok.' }], max_tokens: 8 }),
            signal: AbortSignal.timeout(60000),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (err) { json = null; }
        const reply = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
        return { ok: res.status === 200, status: res.status, ms: Date.now() - started, reply: (reply || text).slice(0, 60) };
    } catch (err) {
        return { ok: false, status: 0, ms: Date.now() - started, reply: err.message };
    }
}

function planAll({ home, baseUrl, apiKey, model }) {
    const A = require('./setup-agents.js');
    const ctx = { home, root: ROOT, cwd: process.cwd(), pathEnv: process.env.PATH || '', platform: process.platform };
    const read = A.fileReader(ctx, { salt: crypto.randomBytes(16) });
    const out = [];
    for (const target of A.VALID_TARGETS) {
        try {
            out.push({ target, plan: A.planTarget(target, { model, mode: 'add', baseUrl, apiKey }, ctx, { read }) });
        } catch (err) {
            out.push({ target, error: err.message || String(err) });
        }
    }
    return out;
}

async function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(`FreeDeepseekAPI integration check

Compares every agent config with the proxy that is running: model ids, context
window, base URL, key, and whether the file on disk still matches what
"npm run setup:agents" writes. Reads only; writes nothing.

Usage:
  node scripts/verify_integrations.js
  node scripts/verify_integrations.js --base-url http://127.0.0.1:9655 --probe
  node scripts/verify_integrations.js --offline --json

Options:
  --base-url   proxy origin (default: PROXY_BASE_URL or http://127.0.0.1:9655)
  --api-key    proxy key (default: PROXY_API_KEY)
  --model      model id the plans are built with (default: deepseek-v4-flash)
  --probe      also send one real completion through the proxy
  --offline    skip the proxy, check files only
  --json       machine-readable report
  --strict     treat notes as problems
`);
        return 0;
    }
    const asJson = argv.includes('--json');
    const offline = argv.includes('--offline');
    const strict = argv.includes('--strict');
    const baseUrl = String(cliValue(argv, '--base-url', process.env.PROXY_BASE_URL || `http://127.0.0.1:${process.env.PORT || 9655}`)).replace(/\/+$/, '');
    const apiKey = cliValue(argv, '--api-key', process.env.PROXY_API_KEY || 'local');
    const model = cliValue(argv, '--model', 'deepseek-v4-flash');

    let proxy = { up: false, reason: offline ? 'skipped (--offline)' : 'unreachable', models: [], accounts: null, promptChars: Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS) || 80000 };
    if (!offline) {
        try {
            proxy = await fetchProxy(baseUrl, apiKey);
        } catch (err) {
            proxy = { ...proxy, reason: err.name === 'TimeoutError' ? 'timed out' : err.message };
        }
    }

    const planned = planAll({ home: require('os').homedir(), baseUrl, apiKey, model });
    const results = [];
    for (const item of planned) {
        if (item.error) {
            results.push({ target: item.target, error: item.error, problems: [], notes: [] });
            continue;
        }
        const files = item.plan.files || [];
        const installed = files.filter((f) => f.existed);
        const stale = installed.filter((f) => f.after !== f.before);
        const problems = [];
        const notes = [];
        const referenced = new Set();
        for (const file of files) {
            // Only the gateway's own provider block is our business: another provider in the
            // same OpenCode config (an OpenRouter block, say) names models this proxy never
            // claimed to serve, and flagging them was a false positive.
            if (item.target === 'opencode' && file.id === 'config') {
                try {
                    const cfg = JSON.parse(file.after);
                    const own = (cfg.provider && cfg.provider.freedeepseek && cfg.provider.freedeepseek.models) || {};
                    for (const id of Object.keys(own)) referenced.add(id);
                    continue;
                } catch (err) { /* fall through to the text scan */ }
            }
            for (const id of collectModelIds(file.after)) referenced.add(id);
        }
        const served = proxy.models || [];
        const legacy = ['deepseek-v4-flash', 'deepseek-v4-flash-thinking'];
        const notServed = [...referenced].filter((id) => served.length && !served.includes(id) && !legacy.includes(id));
        if (notServed.length) problems.push(`config names model(s) the proxy does not serve: ${notServed.join(', ')}`);
        // OpenCode's JSON is the one config with hard numbers worth verifying.
        const configFile = files.find((f) => f.id === 'config');
        if (item.target === 'opencode' && configFile && configFile.after) {
            let cfg = null;
            try { cfg = JSON.parse(configFile.after); } catch (err) { problems.push(`generated config is not valid JSON: ${err.message}`); }
            if (cfg) {
                const verdict = checkOpencodeConfig(cfg, { models: served, baseUrl, apiKey, promptChars: proxy.promptChars });
                problems.push(...verdict.problems);
                notes.push(...verdict.notes);
            }
        }
        if (stale.length) {
            notes.push(`stale: ${stale.map((f) => f.id).join(', ')} differ from what setup writes — npm run setup:agents -- --target ${item.target}`);
        }
        if (!installed.length) notes.push('not installed');
        results.push({ target: item.target, installed: installed.length, files: files.length, stale: stale.length, problems, notes });
    }

    let probe = null;
    if (argv.includes('--probe') && proxy.up) {
        probe = await probeCompletion(baseUrl, apiKey, servedModelFor(proxy.models, model));
        if (!probe.ok) results.push({ target: 'proxy', problems: [`live completion failed: HTTP ${probe.status} ${probe.reply}`], notes: [] });
    }

    const failing = results.filter((r) => r.error || r.problems.length);
    const noted = results.filter((r) => !r.error && !r.problems.length && r.notes.length);
    const clean = results.filter((r) => !r.error && !r.problems.length && !r.notes.length);

    if (asJson) {
        console.log(JSON.stringify({
            proxy: { baseUrl, up: proxy.up, reason: proxy.reason || null, models: proxy.models, accounts: proxy.accounts ? proxy.accounts.length : null, promptChars: proxy.promptChars },
            probe,
            results,
            summary: { failing: failing.length, noted: noted.length, clean: clean.length },
        }, null, 2));
        return failing.length || (strict && noted.length) ? 2 : 0;
    }

    console.log('FreeDeepseekAPI integration check');
    const accountText = proxy.accounts ? `${proxy.accounts.filter((a) => String(a.status || a.state || '') === 'ready').length || proxy.accounts.length}/${proxy.accounts.length} accounts` : 'accounts unknown';
    console.log(`proxy   ${baseUrl}  ${proxy.up ? `up · ${accountText}` : `DOWN (${proxy.reason})`}`);
    console.log(`models  ${proxy.models.length ? proxy.models.join(', ') : 'not reported'}`);
    console.log(`prompt  cut at ${proxy.promptChars} chars (~${Math.floor(proxy.promptChars / CHARS_PER_TOKEN)} tokens)`);
    console.log('');
    const width = Math.max(12, ...results.map((r) => r.target.length));
    for (const r of results) {
        const mark = r.error || r.problems.length ? '✗' : r.notes.length ? '!' : '✓';
        const state = r.error ? 'error' : r.installed === 0 ? 'not installed' : `${r.installed}/${r.files} files`;
        console.log(`${mark} ${r.target.padEnd(width)} ${state}`);
        if (r.error) console.log(`    ${r.error}`);
        for (const p of r.problems) console.log(`    ✗ ${p}`);
        for (const n of r.notes) console.log(`    · ${n}`);
    }
    if (probe) console.log(`\nprobe   HTTP ${probe.status} in ${probe.ms}ms — "${probe.reply.replace(/\s+/g, ' ').trim()}"`);
    console.log(`\n[integrations] ${clean.length} clean · ${noted.length} with notes · ${failing.length} failing`);
    return failing.length || (strict && noted.length) ? 2 : 0;
}

function servedModelFor(models, preferred) {
    if (!Array.isArray(models) || !models.length) return preferred;
    if (models.includes(preferred)) return preferred;
    return models.find((id) => /nosearch$/.test(id)) || models[0];
}

if (require.main === module) {
    main()
        .then((code) => { process.exitCode = code; })
        .catch((err) => { console.error('[integrations] ERROR:', err.message); process.exit(1); });
}

module.exports = { collectModelIds, checkOpencodeConfig, originOf, servedModelFor, MODEL_ID_RE };

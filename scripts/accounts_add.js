#!/usr/bin/env node
/**
 * accounts_add.js — add one login or fifty in a single step.
 *
 *   npm run accounts:add -- ~/Downloads/acme.json ~/captures/
 *   npm run accounts:add -- captures/*.json --json
 *   npm run accounts:add -- captures/ --dry-run
 *
 * Each file is a cookie jar exported from the browser (DeepSeek, Claude or Grok —
 * the server detects which from the jar itself). The running gateway is asked to
 * import them through the same path the dashboard uses: provider detection, a live
 * verification against the upstream, duplicate refusal, and a re-capture of an
 * account that is already loaded. Nothing is written here, so the pool and the
 * dashboard stay in step with what actually landed.
 *
 * Exit status: 0 when every login was added or already loaded, 1 when any was
 * rejected, 2 when the gateway could not be reached.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SERVER = process.env.SEEK_BASE_URL || `http://127.0.0.1:${process.env.PORT || 9655}`;
const MAX_BATCH = 50;

function argValue(argv, ...names) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (names.includes(arg)) return argv[i + 1] || '';
    for (const name of names) {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return '';
}

function collectFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    let stat;
    try { stat = fs.statSync(input); } catch (err) { throw new Error(`${input}: ${err.code === 'ENOENT' ? 'no such file or directory' : err.message}`); }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(input).sort()) {
        // A capture folder can hold the audit trail the inbox writes; only the jars matter.
        if (!name.toLowerCase().endsWith('.json')) continue;
        const full = path.join(input, name);
        try { if (fs.statSync(full).isFile()) files.push(full); } catch (err) { /* vanished */ }
      }
    } else {
      files.push(input);
    }
  }
  return files;
}

function readJar(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const jar = JSON.parse(raw);
  if (!jar || typeof jar !== 'object' || Array.isArray(jar)) throw new Error('expected a JSON object');
  return jar;
}

// The filename is the account name, so a folder of `acme.json`, `beta.json` lands as
// acme and beta. A name inside the jar wins, because that is what the operator typed
// when the capture was taken.
function nameFor(file, jar) {
  const declared = typeof jar.name === 'string' ? jar.name.trim() : '';
  if (declared) return declared;
  return path.basename(file, path.extname(file)).trim();
}

async function postBatch(server, accounts, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${server}/admin/accounts/bulk`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accounts }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* reported below */ }
  if (!json) throw new Error(`gateway answered ${res.status} with non-JSON: ${text.slice(0, 160)}`);
  if (!res.ok && res.status !== 207) {
    throw new Error(json?.error?.message || json?.error || `gateway answered ${res.status}`);
  }
  return json;
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: accounts_add.js <file.json|folder> [...] [--server URL] [--json] [--dry-run]');
    console.log('');
    console.log('  Each file is a browser-exported cookie jar; the provider is detected from it.');
    console.log('  --dry-run   list what would be sent, without contacting the gateway');
    console.log('  --server    gateway origin (default http://127.0.0.1:9655)');
    return 0;
  }
  const asJson = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const server = argValue(argv, '--server').replace(/\/+$/, '') || DEFAULT_SERVER;
  const apiKey = argValue(argv, '--api-key') || process.env.PROXY_API_KEY || '';
  const inputs = argv.filter((arg, i) => !arg.startsWith('--') && !String(argv[i - 1] || '').startsWith('--'));

  if (!inputs.length) {
    console.error('[accounts] no file or folder given');
    return 2;
  }
  let files;
  try { files = collectFiles(inputs); } catch (err) { console.error(`[accounts] ${err.message}`); return 2; }
  if (!files.length) {
    console.error('[accounts] no .json capture found in the paths given');
    return 2;
  }

  const accounts = [];
  const bad = [];
  for (const file of files) {
    try {
      const jar = readJar(file);
      accounts.push({ name: nameFor(file, jar), auth: jar, file });
    } catch (err) {
      bad.push({ file, message: err.message });
    }
  }
  if (!asJson) {
    for (const entry of accounts) console.log(`  ${entry.name.padEnd(24)} ${path.basename(entry.file || '')}`);
    for (const entry of bad) console.log(`  ${path.basename(entry.file)}: unreadable (${entry.message})`);
    console.log(`\n${accounts.length} capture(s) ready${bad.length ? `, ${bad.length} unreadable` : ''}`);
  }
  if (dryRun) {
    if (asJson) console.log(JSON.stringify({ dry_run: true, ready: accounts.map(a => a.name), unreadable: bad }, null, 2));
    return bad.length ? 1 : 0;
  }

  let report = null;
  try {
    // Chunked so a 200-capture folder still goes through the same verified path.
    const results = [];
    for (let i = 0; i < accounts.length; i += MAX_BATCH) {
      const chunk = accounts.slice(i, i + MAX_BATCH);
      // The server takes name/auth/provider only; the source path stays local.
      const out = await postBatch(server, chunk.map(({ name, auth }) => ({ name, auth })), apiKey);
      results.push(...(out.results || []).map(row => ({ ...row, name: chunk[row.index]?.name || row.name })));
    }
    report = {
      added: results.filter(r => r.ok && !r.replaced).length,
      replaced: results.filter(r => r.ok && r.replaced).length,
      duplicates: results.filter(r => !r.ok && r.error === 'duplicate_account').length,
      failed: results.filter(r => !r.ok && r.error !== 'duplicate_account').length + bad.length,
      results,
      unreadable: bad,
    };
  } catch (err) {
    console.error(`[accounts] ${err.message}`);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message)) {
      console.error('[accounts] is the gateway running?  npm run dashboard');
    }
    return 2;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const row of report.results) {
      if (row.ok) console.log(`  ok    ${row.name.padEnd(24)} ${row.replaced ? 're-captured' : 'added'} as ${row.id}`);
      else if (row.error === 'duplicate_account') console.log(`  skip  ${row.name.padEnd(24)} already loaded`);
      else console.log(`  FAIL  ${row.name.padEnd(24)} ${row.error}: ${row.message}`);
    }
    console.log(`\n${report.added} added · ${report.replaced} re-captured · ${report.duplicates} already loaded · ${report.failed} rejected`);
  }
  return report.failed ? 1 : 0;
}

module.exports = { collectFiles, nameFor, readJar, postBatch, MAX_BATCH };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`[accounts] ${err?.message || err}`);
    process.exit(2);
  });
}

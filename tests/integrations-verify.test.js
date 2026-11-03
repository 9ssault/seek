'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const V = require('../scripts/verify_integrations.js');
const R = require('../scripts/ratelimit_check.js');
const A = require('../scripts/setup-agents.js');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function opencodePlan(home, opts = {}) {
  const ctx = { home, root: ROOT, cwd: home, pathEnv: '', platform: 'linux' };
  return A.planTarget(
    'opencode',
    { model: 'deepseek-v4-flash', mode: 'add', baseUrl: 'http://127.0.0.1:9655', apiKey: 'local', ...opts },
    ctx,
    { read: A.fileReader(ctx, { salt: crypto.randomBytes(16) }) },
  );
}

test('collectModelIds reads every variant and ignores unrelated text', () => {
  const ids = V.collectModelIds('model = "deepseek-v4-flash-thinking-nosearch"\nother = "deepseek-v4-flash"\nhost = chat.deepseek.com');
  assert.deepEqual(ids.sort(), ['deepseek-v4-flash', 'deepseek-v4-flash-thinking-nosearch']);
  assert.deepEqual(V.collectModelIds(''), []);
});

test('originOf normalises a base URL and never throws', () => {
  assert.equal(V.originOf('http://127.0.0.1:9655/v1'), 'http://127.0.0.1:9655');
  assert.equal(V.originOf('not a url'), null);
});

test('checkOpencodeConfig accepts the config setup writes', (t) => {
  const home = tmpdir(t);
  const plan = opencodePlan(home);
  const cfg = JSON.parse(plan.files.find((f) => f.id === 'config').after);
  const verdict = V.checkOpencodeConfig(cfg, {
    // `seek` is the merged id the proxy advertises first; the four DeepSeek variants stay
    // available behind it, so a config that lists all five is served.
    models: ['seek', 'deepseek-v4-flash', 'deepseek-v4-flash-thinking', 'deepseek-v4-flash-nosearch', 'deepseek-v4-flash-thinking-nosearch'],
    baseUrl: 'http://127.0.0.1:9655',
    apiKey: 'local',
    promptChars: 120000,
  });
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.notes, []);
});

test('checkOpencodeConfig names each defect it can see', () => {
  const verdict = V.checkOpencodeConfig({
    provider: {
      freedeepseek: {
        options: { baseURL: 'http://127.0.0.1:9999/v1', apiKey: 'wrong' },
        models: {
          'deepseek-v4-flash': { limit: { context: 1048576 } },
          'gpt-5-codex': { limit: { context: 8192 } },
        },
      },
    },
  }, {
    models: ['deepseek-v4-flash', 'deepseek-v4-flash-thinking'],
    baseUrl: 'http://127.0.0.1:9655',
    apiKey: 'local',
    promptChars: 120000,
  });
  const text = verdict.problems.join(' | ');
  assert.match(text, /baseURL .* is not the proxy/);
  assert.match(text, /apiKey does not match/);
  assert.match(text, /model\(s\) the proxy does not serve: gpt-5-codex/);
  assert.match(text, /advertises 1048576 tokens/);
  assert.match(verdict.notes.join(' | '), /websearch\/webfetch are still on/);
});

test('checkOpencodeConfig refuses a config without the provider', () => {
  const verdict = V.checkOpencodeConfig({ provider: {} }, { models: [] });
  assert.equal(verdict.problems.length, 1);
  assert.match(verdict.problems[0], /provider\.freedeepseek/);
});

test('the shipped OpenCode sample matches what setup generates', (t) => {
  const home = tmpdir(t);
  const generated = JSON.parse(opencodePlan(home).files.find((f) => f.id === 'config').after).provider.freedeepseek;
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations/opencode/opencode.json'), 'utf8')).provider.freedeepseek;
  assert.deepEqual(Object.keys(shipped.models).sort(), Object.keys(generated.models).sort());
  for (const id of Object.keys(generated.models)) {
    assert.equal(shipped.models[id].name, generated.models[id].name, `${id} name drifted from the generator`);
    assert.equal(shipped.models[id].limit.context, generated.models[id].limit.context, `${id} context drifted`);
  }
  assert.equal(shipped.options.baseURL, generated.options.baseURL);
  assert.equal(shipped.options.apiKey, generated.options.apiKey);
});

test('every OpenCode model has a distinct name and an honest context window', (t) => {
  const home = tmpdir(t);
  const models = JSON.parse(opencodePlan(home).files.find((f) => f.id === 'config').after).provider.freedeepseek.models;
  const names = Object.values(models).map((m) => m.name);
  assert.equal(new Set(names).size, names.length, `duplicate model names: ${names.join(', ')}`);
  for (const m of Object.values(models)) {
    assert.ok(m.limit.context <= 100000, `context ${m.limit.context} is not the size the proxy serves`);
    assert.equal(m.limit.output, 8192);
  }
});

test('quarantinePlan selects only dead logins inside the accounts dir', (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, 'dead.json'), '{}');
  fs.writeFileSync(path.join(dir, 'live.json'), '{}');
  fs.writeFileSync(path.join(dir, 'flaky.json'), '{}');
  const plan = R.quarantinePlan([
    { file: path.join(dir, 'dead.json'), kind: 'auth', note: 'biz_code 40003' },
    { file: path.join(dir, 'live.json'), kind: 'ok', note: '' },
    { file: path.join(dir, 'flaky.json'), kind: 'waf', note: 'WAF challenge' },
    { file: path.join(ROOT, 'deepseek-auth.json'), kind: 'auth', note: 'biz_code 40003' },
  ], { accountsDir: dir });
  assert.deepEqual(plan.map((p) => path.basename(p.from)), ['dead.json']);
  assert.equal(plan[0].to, path.join(dir, '.removed', 'dead.json'));
  assert.equal(plan[0].reason, 'biz_code 40003');
});

test('applyQuarantine moves the file and keeps an earlier copy', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'dead.json');
  fs.writeFileSync(file, '{"token":"a"}');
  const first = R.applyQuarantine([{ from: file, to: path.join(dir, '.removed', 'dead.json'), reason: 'x' }]);
  assert.equal(first[0].ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(dir, '.removed', 'dead.json'), 'utf8'), '{"token":"a"}');

  // A second dead login with the same name must not overwrite the first.
  fs.writeFileSync(file, '{"token":"b"}');
  const second = R.applyQuarantine([{ from: file, to: path.join(dir, '.removed', 'dead.json'), reason: 'x' }]);
  assert.equal(second[0].ok, true);
  assert.notEqual(second[0].to, path.join(dir, '.removed', 'dead.json'));
  assert.equal(fs.readFileSync(path.join(dir, '.removed', 'dead.json'), 'utf8'), '{"token":"a"}');
  assert.equal(fs.readFileSync(second[0].to, 'utf8'), '{"token":"b"}');
});

'use strict';

/**
 * setup-tools offline tests. The registry is static data plus a detection pass, so
 * everything except `which()` can be checked without touching the real config dirs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TOOLS,
  PLUGINS,
  plan,
  render,
  renderSkill,
  renderPluginCommand,
  pluginStatus,
  writeCommands,
  writePlugins,
} = require('../scripts/setup-tools.js');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seek-tools-'));

test('every registry entry is complete and unique', () => {
  const ids = TOOLS.map((t) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate tool id');
  for (const tool of TOOLS) {
    assert.match(tool.id, /^[a-z][a-z0-9-]*$/, `${tool.id} is not a safe command name`);
    assert.ok(tool.label && tool.when && tool.usage, `${tool.id} is missing copy`);
    assert.ok(tool.usage.includes('$ARGUMENTS'), `${tool.id} does not accept an argument`);
  }
});

test('a rendered command is valid frontmatter plus a body', () => {
  const tool = TOOLS.find((t) => t.id === 'jadx');
  const out = render(tool, { harness: 'opencode', resolved: '/opt/jadx/bin/jadx' });
  assert.ok(out.startsWith('---\ndescription: '), 'missing frontmatter');
  assert.strictEqual(out.split('---').length >= 3, true, 'frontmatter is not closed');
  assert.match(out, /\/opt\/jadx\/bin\/jadx/);
  assert.match(out, /\$ARGUMENTS/);
  assert.match(out, /Report the command you ran/);
});

test('a missing tool is told not to pretend', () => {
  const tool = TOOLS.find((t) => t.id === 'ida');
  const out = render(tool, { harness: 'opencode', resolved: '' });
  assert.match(out, /Not installed/);
  assert.match(out, /Do not pretend to have run it/);
});

test('codex receives an argument hint', () => {
  const out = render(TOOLS[0], { harness: 'codex', resolved: '/usr/bin/x' });
  assert.match(out, /argument-hint: <target>/);
  assert.ok(!render(TOOLS[0], { harness: 'opencode', resolved: '/usr/bin/x' }).includes('argument-hint'));
});

test('a skill entry is a one-line pointer, not the whole manual', () => {
  const out = renderSkill(TOOLS[0], '/usr/bin/x');
  assert.match(out, /^---\nname: rea\ndescription: /);
  assert.match(out, /\/rea/);
  assert.ok(out.split('\n').length < 15, 'skill entry is too long to stay cheap');
});

test('the vendored pentest plugin is detected and its root is resolved', () => {
  const plugin = PLUGINS.find((p) => p.id === 'pentest');
  const status = pluginStatus(plugin);
  assert.ok(status.present, `plugin missing: ${status.missing.join(', ')}`);
  const out = renderPluginCommand(plugin);
  assert.ok(out.includes(plugin.root), 'absolute root not substituted');
  assert.ok(out.includes(path.join(plugin.root, 'scripts', 'ht_preflight.py')));
  assert.match(out, /\$ARGUMENTS/);
});

test('plugin skill substitutes the plugin root placeholder', () => {
  const plugin = PLUGINS.find((p) => p.id === 'pentest');
  const body = fs.readFileSync(path.join(plugin.root, 'skills', plugin.id, 'SKILL.md'), 'utf8');
  const expected = body.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.root);
  const written = renderPluginCommand(plugin);
  assert.ok(written.includes(plugin.root));
  assert.ok(expected.includes(plugin.root));
});

test('writing lands in both harnesses and the skill directory', () => {
  const dir = tmpdir();
  const opencodeDir = path.join(dir, 'command');
  const codexDir = path.join(dir, 'prompts');
  const skillsDir = path.join(dir, 'skills');
  const entries = TOOLS.slice(0, 2).map((t) => ({ ...t, resolved: '/usr/bin/' + t.id, available: true, write: true }));
  const written = writeCommands(entries, { opencodeDir, codexDir, skillsDir, skills: true });

  assert.strictEqual(written.filter((w) => w.harness === 'opencode').length, 2);
  assert.strictEqual(written.filter((w) => w.harness === 'codex').length, 2);
  assert.strictEqual(written.filter((w) => w.harness === 'opencode-skill').length, 2);
  for (const item of written) assert.ok(fs.existsSync(item.file), `${item.file} was not written`);
  assert.match(fs.readFileSync(path.join(opencodeDir, `${entries[0].id}.md`), 'utf8'), /\$ARGUMENTS/);
});

test('dry run writes nothing', () => {
  const dir = tmpdir();
  const entries = [{ ...TOOLS[0], resolved: '/usr/bin/x', available: true, write: true }];
  const written = writeCommands(entries, { dryRun: true, opencodeDir: path.join(dir, 'c'), codexDir: path.join(dir, 'p'), skillsDir: path.join(dir, 's'), skills: true });
  assert.strictEqual(written.length, 3);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('plan exposes availability without installing anything', () => {
  const entries = plan({ only: ['rea'] });
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].id, 'rea');
  assert.strictEqual(typeof entries[0].available, 'boolean');
});

test('plugin commands are written only when the plugin is vendored', () => {
  const dir = tmpdir();
  const written = writePlugins({ opencodeDir: path.join(dir, 'c'), codexDir: path.join(dir, 'p'), skillsDir: path.join(dir, 's') });
  for (const item of written) assert.ok(fs.existsSync(item.file));
  if (written.length) assert.ok(written.some((w) => w.harness === 'opencode-skill'));
});

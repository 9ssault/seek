// The web model does not always reproduce the JSON envelope it was asked for. When it
// falls back it writes its own tag dialect, and every one of these replies used to be
// answered with "Tool-call markup detected but invalid/truncated ... retrying" — a second
// upstream round trip (10-35s) per turn, several per request, and when the retry failed
// too the raw tags were handed to OpenCode as assistant text.
//
// These cases pin the dialect that must resolve on the FIRST read: singular call tags,
// `<|…|>` native tokens, `<function_calls>` wrappers, `string="false"` parameters, a
// self-closing no-argument call, a JSON body, and a tool name carried by a
// `<parameter name="name">` child. Anything that is not one of our tags stays prose.
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../server.js').__test;
assert.equal(typeof S.listLooseToolCalls, 'function', 'server.js must export listLooseToolCalls');
assert.equal(typeof S.collectAgentToolCalls, 'function', 'server.js must export collectAgentToolCalls');

const TOOLS = new Set(['shell', 'read', 'write', 'edit', 'list_files']);

function calls(text, allowed = TOOLS) {
  return S.collectAgentToolCalls(text, allowed);
}

function args(call) {
  return JSON.parse(call.arguments);
}

// The exact shape reported from OpenCode: a bar-delimited call tag whose name never made
// it onto the tag, so the model wrote it as the first parameter instead.
test('a bare bar-delimited tool_call with the name in a parameter is read', () => {
  const text = [
    '<｜tool_call>',
    '<parameter name="name">shell</parameter>',
    '<parameter name="command">ls -la</parameter>',
    '</tool_call>',
  ].join('\n');
  const list = calls(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'shell');
  assert.deepEqual(args(list[0]), { command: 'ls -la' });
});

test('a singular <tool_call name="…"> tag is read', () => {
  const list = calls('<tool_call name="read"><parameter name="path">/tmp/a.txt</parameter></tool_call>');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'read');
  assert.deepEqual(args(list[0]), { path: '/tmp/a.txt' });
});

test('native begin/end token markers are tolerated', () => {
  const text = '<|tool_call▁begin|><parameter name="name">shell</parameter><parameter name="command">pwd</parameter><|tool_call▁end|>';
  const list = calls(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'shell');
  assert.deepEqual(args(list[0]), { command: 'pwd' });
});

test('a <function_call> with a JSON-typed parameter keeps the value type', () => {
  const text = [
    '<function_call name="write">',
    '<parameter name="path">notes.md</parameter>',
    '<parameter name="content" string="false">{"k":1}</parameter>',
    '</function_call>',
  ].join('');
  const list = calls(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'write');
  assert.deepEqual(args(list[0]), { path: 'notes.md', content: { k: 1 } });
});

test('an <invoke> without the tool_calls wrapper is still a call', () => {
  const list = calls('<invoke name="shell"><parameter name="command">git status</parameter></invoke>');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'shell');
  assert.deepEqual(args(list[0]), { command: 'git status' });
});

test('two calls in one <function_calls> wrapper are both read', () => {
  const text = [
    '<function_calls>',
    '<invoke name="read"><parameter name="path">a.js</parameter></invoke>',
    '<invoke name="read"><parameter name="path">b.js</parameter></invoke>',
    '</function_calls>',
  ].join('');
  const list = calls(text);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(call => args(call).path), ['a.js', 'b.js']);
});

test('surrounding prose does not swallow the call', () => {
  const text = 'Reading the file now.\n<tool_call name="read"><parameter name="path">x</parameter></tool_call>\nDone.';
  const list = calls(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'read');
});

test('a self-closing call is a no-argument call', () => {
  const list = calls('<tool_call name="list_files"/>');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'list_files');
  assert.deepEqual(args(list[0]), {});
});

test('a JSON envelope inside a call tag is read', () => {
  const list = calls('<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'shell');
  assert.deepEqual(args(list[0]), { command: 'ls' });
});

test('a tool the request never advertised is not executable', () => {
  const list = calls('<tool_call name="rm_rf"><parameter name="path">/</parameter></tool_call>');
  assert.deepEqual(list, []);
});

test('html-looking prose is not a tool call', () => {
  const text = 'Wrap the value in <parameter> tags or use <div class="x">markup</div>.';
  assert.deepEqual(calls(text), []);
  assert.equal(S.hasDsmlToolMarkup('Wrap the value in <parameter> tags.'), false);
});

test('an unterminated call tag never yields a half-parsed call', () => {
  const text = '<tool_call name="write"><parameter name="path">a</parameter><parameter name="content">half';
  assert.deepEqual(calls(text), []);
});

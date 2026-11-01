// RED/GREEN regression for the ACTUAL captured production defect.
//
// Capture: C:/Users/wigmore/.hermes/cache/scratch/deepseek_real_agent_capture.jsonl
//   stage=repair_trigger, agentId=20261014_211410_d7dd2d, apiMode=openai
// The DeepSeek web backend emitted a strict-JSON tool envelope whose final object
// closing brace was missing. Every string was closed and every value was present, so
// the ONLY defect was one missing closing delimiter. The parser returned null and the
// tool call was lost.
//
// The fixture below is the captured fullContent byte for byte (sha256 pinned). Nothing
// is reconstructed, invented or re-typed: the expected arguments are derived from the
// fixture bytes themselves, so "byte-identical" is enforced, not asserted by eye.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const S = require('../server.js').__test;
assert.equal(typeof S.repairTruncatedJsonEnvelope, 'function', 'server.js must export repairTruncatedJsonEnvelope');
const repair = S.repairTruncatedJsonEnvelope;
const TOOLS = new Set(['write_file', 'read_file', 'terminal']);

const FIXTURE = path.join(__dirname, 'fixtures', 'deepseek_real_capture_9699_fullcontent.json');
const FIXTURE_SHA256 = 'f25aff052aa743d9f0edefea790d786b6a9cc8d91dc87b564e64076d46293710';
const CAPTURE_PATH = 'C:/Users/wigmore/.hermes/cache/scratch/deepseek_actual_write.txt';
const PREFIX = '{"tool_call":{"name":"write_file","arguments":{"path":"' + CAPTURE_PATH + '","content":"';

const fixture = fs.readFileSync(FIXTURE, 'utf8');
// Drop the envelope's trailing `"}}` to recover the captured content bytes verbatim.
const captureContent = fixture.slice(PREFIX.length, -3);

function recovered(text) {
  const calls = S.collectAgentToolCalls(text, TOOLS);
  return { calls, call: calls[0] || S.selectAgentToolCall(text, TOOLS) };
}

// ---------------------------------------------------------------------------
// GREEN: the real capture.
// ---------------------------------------------------------------------------

test('R0 the fixture is the byte-exact captured fullContent', () => {
  assert.equal(fixture.length, 3055);
  assert.equal(crypto.createHash('sha256').update(fixture, 'utf8').digest('hex'), FIXTURE_SHA256);
  assert.equal(fixture.startsWith(PREFIX), true);
  assert.equal(fixture.endsWith('"}}'), true);
  assert.equal(captureContent, 'ABCDEFGHIJ'.repeat(292));
});

test('R1 REAL capture: the one missing final } is repaired and write_file is recovered', () => {
  assert.equal(S.looksLikeToolCallMarkup(fixture), true, 'the capture is recognised as tool markup');

  const { calls, call } = recovered(fixture);
  assert.ok(call, 'the captured truncated envelope must be recovered');
  assert.equal(call.name, 'write_file');
  assert.equal(calls.length, 1);

  const args = JSON.parse(call.arguments);
  assert.equal(args.path, CAPTURE_PATH);
  assert.equal(args.content, captureContent);
  assert.equal(
    call.arguments,
    JSON.stringify({ path: CAPTURE_PATH, content: captureContent }),
    'arguments must be byte-identical to the captured bytes'
  );
});

test('R2 REAL capture: parseToolCall (single-call path) also recovers it', () => {
  const call = S.parseToolCall(fixture);
  assert.ok(call, 'parseToolCall must recover the captured envelope');
  assert.equal(call.name, 'write_file');
  assert.equal(call.arguments, JSON.stringify({ path: CAPTURE_PATH, content: captureContent }));
});

test('R3 repair is closing-delimiter-only: the recovered bytes are the input plus }', () => {
  const repaired = repair(fixture);
  assert.equal(repaired, fixture + '}');
});

// ---------------------------------------------------------------------------
// GUARDS: recovery cases.
// ---------------------------------------------------------------------------

test('G1 missingonebrace: one missing } is appended', () => {
  const text = '{"tool_call":{"name":"read_file","arguments":{"path":"a.txt"}}';
  assert.equal(repair(text), text + '}');
  assert.equal(S.selectAgentToolCall(text, TOOLS).name, 'read_file');
});

test('G2 multipleclosers: several missing }/] are appended in the right order', () => {
  const text = '{"tool_call":{"name":"read_file","arguments":{"opts":[1,2';
  assert.equal(repair(text), text + ']}}}');
  const call = S.selectAgentToolCall(text, TOOLS);
  assert.equal(call.name, 'read_file');
  assert.deepEqual(JSON.parse(call.arguments).opts, [1, 2]);
});

test('G3 bracesinsideescapedstrings: delimiters inside strings never affect the stack', () => {
  const complete = '{"tool_call":{"name":"write_file","arguments":{"content":"{\\"a\\":1}"}}}';
  const truncated = '{"tool_call":{"name":"write_file","arguments":{"content":"{\\"a\\":1}"}}';

  // A complete document is untouched.
  assert.equal(repair(complete), null);
  const done = S.selectAgentToolCall(complete, TOOLS);
  assert.equal(done.arguments, JSON.stringify({ content: '{"a":1}' }));

  // Truncated by exactly one brace, with braces/escapes inside the string value.
  assert.equal(repair(truncated), truncated + '}');
  const call = S.selectAgentToolCall(truncated, TOOLS);
  assert.equal(call.name, 'write_file');
  assert.equal(JSON.parse(call.arguments).content, '{"a":1}');
});

test('G4 validalready: complete inputs are returned unchanged and repair is a no-op', () => {
  const complete = JSON.stringify({ tool_call: { name: 'terminal', arguments: { command: 'echo hi' } } });
  assert.equal(repair(complete), null, 'nothing is appended to a complete document');
  assert.equal(S.selectAgentToolCall(complete, TOOLS).arguments, JSON.stringify({ command: 'echo hi' }));

  const bare = '{"tool_call":{"name":"terminal"}}';
  assert.equal(repair(bare), null);
  assert.equal(S.selectAgentToolCall(bare, TOOLS).name, 'terminal');

  const fenced = 'Here is the call:\n```json\n' + complete + '\n```';
  assert.equal(S.selectAgentToolCall(fenced, TOOLS).name, 'terminal');
  assert.equal(S.selectAgentToolCall(fenced, TOOLS).arguments, JSON.stringify({ command: 'echo hi' }));
});

test('G5 longcontent: a 3000-char argument survives the repair byte for byte', () => {
  const long = 'L'.repeat(3000);
  const text = '{"tool_call":{"name":"write_file","arguments":{"path":"big.txt","content":"' + long + '"}}';
  assert.equal(repair(text), text + '}');
  const call = S.selectAgentToolCall(text, TOOLS);
  assert.equal(call.name, 'write_file');
  const args = JSON.parse(call.arguments);
  assert.equal(args.content.length, 3000);
  assert.equal(args.content, long);
  assert.equal(call.arguments, JSON.stringify({ path: 'big.txt', content: long }));
});

test('G6 arrayclosure: an unterminated array inside the envelope is closed with ]', () => {
  const text = '{"tool_call":{"name":"write_file","arguments":{"content":[1,2';
  assert.equal(repair(text), text + ']}}}');
  const call = S.selectAgentToolCall(text, TOOLS);
  assert.equal(call.name, 'write_file');
  assert.deepEqual(JSON.parse(call.arguments).content, [1, 2]);
});

test('G7 a top-level truncated array envelope is closed with ]', () => {
  const text = '[{"tool_call":{"name":"read_file","arguments":{"path":"x"}}';
  assert.equal(repair(text), text + '}]');
  const call = S.selectAgentToolCall(text, TOOLS);
  assert.equal(call.name, 'read_file');
  assert.equal(JSON.parse(call.arguments).path, 'x');
});

// ---------------------------------------------------------------------------
// GUARDS: fail-closed cases. These must hold on the repaired parser.
// ---------------------------------------------------------------------------

function mustReject(text, why) {
  assert.equal(repair(text), null, why + ' (repair must refuse)');
  assert.equal(S.parseToolCall(text), null, why + ' (parseToolCall must not invent a call)');
  assert.equal(S.selectAgentToolCall(text, TOOLS), null, why + ' (no call may be invented)');
  assert.equal(S.collectAgentToolCalls(text, TOOLS).length, 0, why + ' (no call may be invented)');
}

test('G8 unterminatedcontent REJECT: an unclosed string is never completed', () => {
  mustReject('{"tool_call":{"name":"terminal","arguments":{"command":"echo hi', 'unterminated string');
  mustReject('{"tool_call":{"name":"terminal","arguments":{"command":"echo \\', 'unterminated escape');
});

test('G9 colonmissingvalue REJECT: no colon or value is ever invented', () => {
  mustReject('{"tool_call":{"name":"terminal","arguments":{"command" "echo hi"', 'missing colon');
  mustReject('{"tool_call":{"name":"terminal","arguments":{"command":', 'missing value');
  mustReject('{"tool_call":{"name":"terminal","arguments":{"a":1,', 'trailing comma');
  // A complete document followed by prose is already parsed by the existing balanced-object
  // scan; the repair must simply add nothing to it.
  assert.equal(repair('{"tool_call":{"name":"terminal","arguments":{"a":1}}} trailing prose'), null, 'nothing is appended after a complete document');
});

test('G10 mismatchedclose REJECT: a closer that does not match the open one is refused', () => {
  mustReject('{"tool_call":{"name":"terminal","arguments":{"command":[1}', 'mismatched closer');
  mustReject('{"a":[1}', 'array closed by a brace');
  assert.equal(repair('{"a":1]}'), null, 'stray closer');
});

test('G11 non-JSON text is never repaired into a document', () => {
  mustReject('plain prose with no envelope at all', 'no envelope');
  mustReject('{"tool_call":{"name":"terminal","arguments":{"command":"echo hi', 'markup is recognised but the string is open');
  assert.equal(S.looksLikeToolCallMarkup('{"tool_call":{"name":"terminal","arguments":{"command":"echo hi'), true);
});

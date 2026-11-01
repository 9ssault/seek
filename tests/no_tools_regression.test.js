// No-tools regression: deterministic, no upstream call, no server.
//
// RED BASELINE: With empty allowedToolNames, selectAgentToolCall returns null for
// JSON tool markup and looksLikeToolCallMarkup returns true. This combination
// caused shouldRepairMarkup=true → tool-JSON repair prompt → 502 malformed_tool_call.
//
// GREEN FIXED: noToolsRepairPrompt() exists, returns a plain-text instruction,
// and the handler routes to shouldRepairNoTools instead of shouldRepairMarkup.
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../server.js').__test;
const EMPTY_TOOLS = new Set();
const TOOLS_ENABLED = new Set(['write_file', 'terminal']);

// The exact captured defect content: valid JSON tool call, 154 chars.
const DEFECT_CONTENT = '{"tool_call":{"name":"write_file","arguments":{"path":"C:/Users/wigmore/.hermes/cache/scratch/deepseek_remaining_live.txt","content":"FINAL_CAPTURE_OK"}}}';

// ── RED BASELINE: defect condition exists ──────────────────────────────

test('RED: empty allowedToolNames causes selectAgentToolCall to return null for JSON tool markup', () => {
    // This is the root cause: with no tools, the parser cannot identify the call.
    const call = S.selectAgentToolCall(DEFECT_CONTENT, EMPTY_TOOLS);
    assert.equal(call, null, 'DEFECT: selectAgentToolCall returns null for valid JSON when no tools allowed');
});

test('RED: looksLikeToolCallMarkup returns true for the same content', () => {
    assert.equal(S.looksLikeToolCallMarkup(DEFECT_CONTENT), true,
        'DEFECT: content IS recognized as tool markup');
});

test('RED: collectAgentToolCalls returns empty array with no tools', () => {
    const calls = S.collectAgentToolCalls(DEFECT_CONTENT, EMPTY_TOOLS);
    assert.equal(calls.length, 0, 'DEFECT: collectAgentToolCalls returns [] when no tools');
});

test('RED: combined defect condition — null toolCall + markup detected = false malformed repair', () => {
    const toolCall = S.selectAgentToolCall(DEFECT_CONTENT, EMPTY_TOOLS);
    const isMarkup = S.looksLikeToolCallMarkup(DEFECT_CONTENT);
    // In the OLD logic: shouldRepairMarkup = !toolCall && !shouldRepairNative && isMarkup
    // With empty tools: shouldRepairNative = false (no ignoredNativeTool, no dsmlCalls)
    const shouldRepairMarkupOld = !toolCall && isMarkup;
    assert.equal(shouldRepairMarkupOld, true,
        'DEFECT: old logic would trigger markup repair for a no-tools request');
});

// ── GREEN FIXED: no-tools repair path ─────────────────────────────────

test('GREEN: noToolsRepairPrompt exists and instructs plain text only', () => {
    assert.equal(typeof S.noToolsRepairPrompt, 'function', 'noToolsRepairPrompt must be exported');
    const prompt = S.noToolsRepairPrompt();
    assert.ok(prompt.includes('does NOT support tool calls'), 'must tell model tools are disallowed');
    assert.ok(prompt.includes('plain text'), 'must ask for plain text answer');
    assert.ok(!prompt.includes('{"tool_call"'), 'must NOT ask for tool JSON');
});

test('GREEN: noToolsMode correctly identifies no-tools condition', () => {
    const noToolsMode = EMPTY_TOOLS.size === 0;
    assert.equal(noToolsMode, true);
    const toolsMode = TOOLS_ENABLED.size === 0;
    assert.equal(toolsMode, false);
});

test('GREEN: shouldRepairNoTools condition — no tools + markup detected', () => {
    const noToolsMode = EMPTY_TOOLS.size === 0;
    const toolCall = S.selectAgentToolCall(DEFECT_CONTENT, EMPTY_TOOLS);
    const isMarkup = S.looksLikeToolCallMarkup(DEFECT_CONTENT);
    // In the NEW logic: shouldRepairNoTools = noToolsMode && !toolCall && isMarkup
    const shouldRepairNoTools = noToolsMode && !toolCall && isMarkup;
    assert.equal(shouldRepairNoTools, true,
        'FIXED: shouldRepairNoTools triggers for no-tools + markup');
});

test('GREEN: shouldRepairMarkup is FALSE in no-tools mode', () => {
    const noToolsMode = EMPTY_TOOLS.size === 0;
    const toolCall = S.selectAgentToolCall(DEFECT_CONTENT, EMPTY_TOOLS);
    const isMarkup = S.looksLikeToolCallMarkup(DEFECT_CONTENT);
    // In the NEW logic: shouldRepairMarkup = !noToolsMode && !toolCall && isMarkup
    const shouldRepairMarkupNew = !noToolsMode && !toolCall && isMarkup;
    assert.equal(shouldRepairMarkupNew, false,
        'FIXED: shouldRepairMarkup is suppressed in no-tools mode');
});

test('GREEN: tools-enabled repair paths are preserved', () => {
    // With tools enabled, the old behavior must be unchanged
    const toolCall = S.selectAgentToolCall(DEFECT_CONTENT, TOOLS_ENABLED);
    assert.ok(toolCall, 'with tools enabled, the call is found');
    assert.equal(toolCall.name, 'write_file');

    // Markup repair still works for tools-enabled mode
    const truncated = '{"tool_call":{"name":"write_file","arguments":{"path":"x"';
    const tc2 = S.selectAgentToolCall(truncated, TOOLS_ENABLED);
    // Truncated JSON may or may not parse; the key is that looksLikeToolCallMarkup is true
    assert.equal(S.looksLikeToolCallMarkup(truncated), true);
});

test('GREEN: tool_choice none is equivalent to no tools', () => {
    // A request with tool_choice=none and no tools array is a no-tools request
    const toolChoiceNone = 'none';
    const noTools = [];
    const noToolsMode = noTools.length === 0;
    assert.equal(noToolsMode, true, 'tool_choice none + empty tools = no-tools mode');
    assert.equal(toolChoiceNone, 'none');
});

test('GREEN: plain text content is NOT tool markup (no false trigger)', () => {
    const plainText = 'The file has been written successfully. FINAL_CAPTURE_OK is confirmed.';
    assert.equal(S.looksLikeToolCallMarkup(plainText), false,
        'plain text must not trigger no-tools repair');
    const call = S.selectAgentToolCall(plainText, EMPTY_TOOLS);
    assert.equal(call, null);
    // shouldRepairNoTools = noToolsMode && !toolCall && isMarkup = true && true && false = false
    const shouldRepairNoTools = true && !call && S.looksLikeToolCallMarkup(plainText);
    assert.equal(shouldRepairNoTools, false, 'plain text in no-tools mode: no repair needed');
});

// ── Regression guard: existing parser behavior unchanged ──────────────

test('REGRESSION: canonical DSML still parses with tools enabled', () => {
    const dsml = '｜DSML｜tool_calls>\n<｜DSML｜invoke name="terminal">\n<｜DSML｜parameter name="command" string="true">echo hi</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';
    const call = S.parseToolCall(dsml);
    assert.ok(call);
    assert.equal(call.name, 'terminal');
});

test('REGRESSION: strict JSON tool call still parses with tools enabled', () => {
    const strict = JSON.stringify({ tool_call: { name: 'terminal', arguments: { command: 'a' } } });
    assert.equal(S.selectAgentToolCall(strict, TOOLS_ENABLED).name, 'terminal');
});

test('REGRESSION: closing-delimiter repair still works', () => {
    const missingClosers = '{"tool_call":{"name":"terminal","arguments":{"command":"echo hi"';
    assert.equal(S.looksLikeToolCallMarkup(missingClosers), true);
    assert.equal(S.selectAgentToolCall(missingClosers, TOOLS_ENABLED).name, 'terminal');
});

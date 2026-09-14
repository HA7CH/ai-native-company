import assert from "node:assert/strict";
import test from "node:test";
import { filterToolTurnNarration } from "./tool-turn-filter.mjs";

process.env.ANC_UPSTREAM_BASE_URL ??= "http://127.0.0.1:1";
process.env.ANC_SYSTEM_PROMPT_FILE ??= new URL("./README.md", import.meta.url).pathname;
const { rewriteSystem } = await import("./system-prompt-proxy.mjs");

const sseToolTurn = Buffer.from([
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"让我先查一下技能库"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n"));

test("SSE: narration inside a tool turn is dropped, the tool_use block survives", () => {
  const out = filterToolTurnNarration(sseToolTurn, "text/event-stream").toString("utf8");
  assert.doesNotMatch(out, /让我先查一下技能库/);
  assert.match(out, /"type":"tool_use"/);
  assert.match(out, /message_stop/);
});

test("SSE: a final text-only turn passes through byte-for-byte", () => {
  const final = Buffer.from('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: message_stop\ndata: {"type":"message_stop"}');
  assert.equal(filterToolTurnNarration(final, "text/event-stream"), final);
});

test("JSON: text blocks are removed only when the turn contains tool_use", () => {
  const toolTurn = Buffer.from(JSON.stringify({ content: [{ type: "text", text: "我先读取一下。" }, { type: "tool_use", id: "t2", name: "Read", input: {} }] }));
  assert.deepEqual(JSON.parse(filterToolTurnNarration(toolTurn, "application/json")).content.map((b) => b.type), ["tool_use"]);
  const finalTurn = Buffer.from(JSON.stringify({ content: [{ type: "text", text: "最近推进的是哪件事?" }] }));
  assert.equal(filterToolTurnNarration(finalTurn, "application/json"), finalTurn);
});

test("unknown content types and malformed bodies are left untouched", () => {
  const raw = Buffer.from("not json");
  assert.equal(filterToolTurnNarration(raw, "application/json"), raw);
  assert.equal(filterToolTurnNarration(raw, "text/plain"), raw);
});

test("replace mode makes the persona the only system authority", () => {
  const payload = rewriteSystem({ model: "x", system: "You are Claude Code", tools: [{ name: "Read" }] }, "你是小助手", "replace");
  assert.equal(payload.system, "你是小助手");
  assert.equal(payload.tools.length, 1);
});

test("prepend mode keeps the harness prompt after the persona, string or block array", () => {
  assert.equal(rewriteSystem({ system: "harness" }, "persona", "prepend").system, "persona\n\nharness");
  assert.equal(rewriteSystem({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, "persona", "prepend").system, "persona\n\na\nb");
  assert.equal(rewriteSystem({}, "persona", "prepend").system, "persona");
});

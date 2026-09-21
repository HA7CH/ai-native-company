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

// Consume blocks as a Messages streaming client does: append starts, then
// apply deltas and stops by index. Checking for tool_use text alone misses loss.
for (const newline of ["\n", "\r\n"]) {
  test(`SSE: retained thinking and multiple tool inputs stay addressable (${JSON.stringify(newline)})`, () => {
    const blocks = [
      { type: "text", text: "before" },
      { type: "thinking", thinking: "", signature: "" },
      { type: "tool_use", id: "one", name: "Read", input: {} },
      { type: "text", text: "between" },
      { type: "tool_use", id: "two", name: "Read", input: {} },
    ];
    const events = [];
    for (const [index, content_block] of blocks.entries()) {
      events.push({ type: "content_block_start", index, content_block });
      if (content_block.type === "tool_use") {
        for (const partial_json of ['{"file_path":', `"/tmp/${content_block.id}.txt"}`]) {
          events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
        }
      }
      if (content_block.type === "thinking") {
        events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "reason" } });
      }
      events.push({ type: "content_block_stop", index });
    }
    const wire = events.map((event) => `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join("");
    const filtered = filterToolTurnNarration(Buffer.from(wire), "text/event-stream").toString();
    const content = [];
    const inputs = new Map();
    for (const line of filtered.split(/\r?\n/).filter((line) => line.startsWith("data:"))) {
      const event = JSON.parse(line.slice(5));
      if (event.type === "content_block_start") {
        assert.equal(event.index, content.length);
        content.push(event.content_block);
      } else {
        assert.ok(content[event.index], "delta/stop must refer to a retained content block");
        if (event.delta?.type === "input_json_delta") {
          inputs.set(event.index, (inputs.get(event.index) ?? "") + event.delta.partial_json);
        }
        if (event.delta?.type === "thinking_delta") content[event.index].thinking += event.delta.thinking;
        if (event.type === "content_block_stop" && inputs.has(event.index)) content[event.index].input = JSON.parse(inputs.get(event.index));
      }
    }
    assert.deepEqual(content, [
      { type: "thinking", thinking: "reason", signature: "" },
      { type: "tool_use", id: "one", name: "Read", input: { file_path: "/tmp/one.txt" } },
      { type: "tool_use", id: "two", name: "Read", input: { file_path: "/tmp/two.txt" } },
    ]);
  });
}

// Exercise the real HTTP process, including its environment switch and headers.
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("HTTP: compressed responses remain readable with filtering on/off and other routes", { timeout: 15000 }, async (t) => {
  const payload = { content: [{ type: "text", text: "narration" }, { type: "tool_use", id: "one", name: "Read", input: { file_path: "/tmp/one.txt" } }] };
  const plain = Buffer.from(JSON.stringify(payload));
  const encoders = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const encoding = req.headers["x-test-encoding"];
      res.writeHead(200, { "content-type": "application/json", "content-encoding": encoding });
      res.end(encoding === "broken" ? Buffer.from("not-compressed") : encoders[encoding](plain));
    });
  });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  for (const enabled of ["1", "0"]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./system-prompt-proxy.mjs", import.meta.url))], {
      env: { ...process.env, ANC_PROXY_PORT: "0", ANC_FILTER_TOOL_TURNS: enabled, ANC_SYSTEM_PROMPT_MODE: "replace", ANC_SYSTEM_PROMPT_FILE: fileURLToPath(new URL("./README.md", import.meta.url)), ANC_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(() => { if (child.exitCode === null) child.kill(); });
    try {
      const port = await new Promise((resolve, reject) => {
        let stderr = "";
        child.on("error", reject);
        child.on("exit", () => reject(new Error(`proxy exited before ready: ${stderr}`)));
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          const match = stderr.match(/listening on 127\.0\.0\.1:(\d+)/);
          if (match) resolve(Number(match[1]));
        });
      });
      for (const path of ["/v1/messages", "/v1/models"]) {
        for (const encoding of [...Object.keys(encoders), "broken"]) {
          const { headers, body } = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "x-test-encoding": encoding } }, (res) => {
              const chunks = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("error", reject);
              res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            });
            req.on("error", reject);
            req.end("{}");
          });
          assert.equal(Number(headers["content-length"]), body.length);
          if (encoding === "broken") {
            assert.equal(headers["content-encoding"], encoding);
            assert.equal(body.toString(), "not-compressed");
          } else {
            assert.equal(headers["content-encoding"], undefined);
            assert.deepEqual(JSON.parse(body), { content: enabled === "1" && path === "/v1/messages" ? [payload.content[1]] : payload.content });
          }
        }
      }
    } finally {
      child.kill();
      await exited;
    }
  }
});

// 不是每个 harness 都把请求体一次性交给 http 客户端:流式写 body 的客户端不带
// content-length,走 transfer-encoding: chunked。代理把 body 收进内存后按
// content-length 重发,必须同时删掉 chunked,否则上游看到两个定帧头直接断连。
test("HTTP: a harness that streams its request body still reaches upstream", { timeout: 15000 }, async (t) => {
  const personaFile = fileURLToPath(new URL("./README.md", import.meta.url));
  const persona = fs.readFileSync(personaFile, "utf8").trim();
  const clientErrors = [];
  let forwarded = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      forwarded = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    });
  });
  upstream.on("clientError", (error, socket) => { clientErrors.push(error.code); socket.destroy(); });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });

  const child = spawn(process.execPath, [fileURLToPath(new URL("./system-prompt-proxy.mjs", import.meta.url))], {
    env: { ...process.env, ANC_PROXY_PORT: "0", ANC_SYSTEM_PROMPT_MODE: "replace", ANC_SYSTEM_PROMPT_FILE: personaFile, ANC_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const port = await new Promise((resolve, reject) => {
    let stderr = "";
    child.on("error", reject);
    child.on("exit", () => reject(new Error(`proxy exited before ready: ${stderr}`)));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });

  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    // write() 先于 end():Node 无法预知长度,于是发 chunked 而不是 content-length
    req.write('{"system":"You are Claude Code",');
    req.end('"messages":[]}');
  });

  assert.deepEqual(clientErrors, [], "upstream must accept the forwarded framing");
  assert.equal(status, 200);
  assert.equal(forwarded.headers["transfer-encoding"], undefined);
  assert.equal(Number(forwarded.headers["content-length"]), Buffer.byteLength(forwarded.body));
  assert.equal(JSON.parse(forwarded.body).system, persona, "persona 替换要照常生效");
});

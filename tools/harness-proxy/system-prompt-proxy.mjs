#!/usr/bin/env node
// harness 边界代理:坐在 Claude Code(或任何走 ANTHROPIC_BASE_URL 的 harness)与
// 模型端点之间,做两件事:
//   1. 请求侧:把 /v1/messages 的 system 整段替换(或前置)为应用 persona。
//      根因:harness 自带的 system prompt 携带「Claude Code」身份,第三方模型倾向
//      服从它而不是 append 进去的 persona;工具定义保留在请求里,不受影响。
//   2. 响应侧:过滤含 tool_use 轮次的文本叙述(见 tool-turn-filter.mjs)。
// 零依赖。只监听 127.0.0.1。凭据不经本代理注入,由 harness 自己的 header 透传。
//
// 环境变量:
//   ANC_UPSTREAM_BASE_URL   上游端点,如 https://api.example.com(必填)
//   ANC_SYSTEM_PROMPT_FILE  persona 文件路径(必填)
//   ANC_SYSTEM_PROMPT_MODE  replace(默认)| prepend
//   ANC_PROXY_PORT          监听端口,默认 19147
//   ANC_FILTER_TOOL_TURNS   1(默认)| 0
// harness 侧:ANTHROPIC_BASE_URL=http://127.0.0.1:<port>

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import zlib from "node:zlib";
import { filterToolTurnNarration } from "./tool-turn-filter.mjs";

const upstreamBase = (process.env.ANC_UPSTREAM_BASE_URL ?? "").replace(/\/$/, "");
const promptFile = process.env.ANC_SYSTEM_PROMPT_FILE ?? "";
const mode = process.env.ANC_SYSTEM_PROMPT_MODE ?? "replace";
const port = Number(process.env.ANC_PROXY_PORT ?? 19147);
const filterToolTurns = (process.env.ANC_FILTER_TOOL_TURNS ?? "1") !== "0";

if (!upstreamBase) throw new Error("ANC_UPSTREAM_BASE_URL is required");
if (!promptFile) throw new Error("ANC_SYSTEM_PROMPT_FILE is required");
if (!["replace", "prepend"].includes(mode)) throw new Error("ANC_SYSTEM_PROMPT_MODE must be replace|prepend");
const persona = fs.readFileSync(promptFile, "utf8").trim();

export function rewriteSystem(payload, personaText = persona, rewriteMode = mode) {
  if (!payload || typeof payload !== "object") return payload;
  if (rewriteMode === "replace") {
    payload.system = personaText;
    return payload;
  }
  const existing = Array.isArray(payload.system)
    ? payload.system.map((block) => (typeof block === "string" ? block : block?.text ?? "")).join("\n")
    : String(payload.system ?? "");
  payload.system = existing ? `${personaText}\n\n${existing}` : personaText;
  return payload;
}

function decode(body, encoding) {
  if (!encoding || body.length === 0) return { body, decoded: !encoding };
  try {
    if (encoding === "gzip") return { body: zlib.gunzipSync(body), decoded: true };
    if (encoding === "deflate") return { body: zlib.inflateSync(body), decoded: true };
    if (encoding === "br") return { body: zlib.brotliDecompressSync(body), decoded: true };
  } catch {
    // 上游返回截断的压缩体时保留原样,harness 不应因坏 IO 崩溃
  }
  return { body, decoded: false };
}

const server = http.createServer((request, response) => {
  if (request.url === "/__anc_health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      let body = Buffer.concat(chunks);
      const isMessages = request.method === "POST" && String(request.url).includes("/messages");
      if (isMessages && body.length && String(request.headers["content-type"] ?? "").includes("application/json")) {
        body = Buffer.from(JSON.stringify(rewriteSystem(JSON.parse(body.toString("utf8")))), "utf8");
      }
      const target = new URL(upstreamBase + request.url);
      const headers = { ...request.headers, host: target.host, "content-length": body.length };
      const transport = target.protocol === "https:" ? https : http;
      const upstream = transport.request(target, { method: request.method, headers }, (upstreamResponse) => {
        const parts = [];
        upstreamResponse.on("data", (chunk) => parts.push(chunk));
        upstreamResponse.on("end", () => {
          const contentType = String(upstreamResponse.headers["content-type"] ?? "");
          const original = Buffer.concat(parts);
          const { body: plain, decoded } = decode(original, String(upstreamResponse.headers["content-encoding"] ?? "").toLowerCase());
          const visible = decoded && filterToolTurns && isMessages ? filterToolTurnNarration(plain, contentType) : plain;
          const responseHeaders = { ...upstreamResponse.headers };
          if (decoded) delete responseHeaders["content-encoding"];
          delete responseHeaders["transfer-encoding"];
          responseHeaders["content-length"] = visible.length;
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          response.end(visible);
        });
      });
      upstream.on("error", (error) => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: error.message } }));
      });
      upstream.end(body);
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(port, "127.0.0.1", () => {
    console.error(`[anc-harness-proxy] listening on 127.0.0.1:${server.address().port} mode=${mode} persona_chars=${persona.length}`);
  });
}

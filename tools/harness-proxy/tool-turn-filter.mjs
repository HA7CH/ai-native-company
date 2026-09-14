// 工具轮次叙述过滤:含 tool_use 的模型轮次是 harness 内部轮次,其 text 块
// (「让我先查一下」)不应回到 IM 用户眼前;只含文本的最终轮次原样透传。
// 覆盖 Anthropic Messages API 的两种响应形态:SSE 流与 JSON。零依赖。

function parseSseRecord(record) {
  const data = record
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function filterSse(body) {
  const records = body.toString("utf8").split(/\r?\n\r?\n/);
  const events = records.map(parseSseRecord);
  const toolIndexes = new Set();
  const textIndexes = new Set();
  const keptIndexes = new Map();
  for (const event of events) {
    if (event?.type !== "content_block_start") continue;
    if (event.content_block?.type === "tool_use") toolIndexes.add(event.index);
    if (event.content_block?.type === "text") textIndexes.add(event.index);
    else keptIndexes.set(event.index, keptIndexes.size);
  }
  if (toolIndexes.size === 0) return body;
  const kept = records.flatMap((record, i) => {
    const event = events[i];
    if (!event || !String(event.type).startsWith("content_block_")) return [record];
    if (textIndexes.has(event.index)) return [];
    if (!keptIndexes.has(event.index)) return [record];
    // SDKs append starts to content[], then address deltas/stops by index.
    // Removing text must therefore renumber every retained block event.
    const rewritten = { ...event, index: keptIndexes.get(event.index) };
    let wroteData = false;
    const lines = record.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("data:")) return [line];
      if (wroteData) return [];
      wroteData = true;
      return [`data: ${JSON.stringify(rewritten)}`];
    });
    return [lines.join("\n")];
  });
  return Buffer.from(kept.join("\n\n"), "utf8");
}

function filterJson(body) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!Array.isArray(payload.content)) return body;
  if (!payload.content.some((block) => block?.type === "tool_use")) return body;
  payload.content = payload.content.filter((block) => block?.type !== "text");
  return Buffer.from(JSON.stringify(payload), "utf8");
}

/** @param {Buffer} body @param {string} contentType */
export function filterToolTurnNarration(body, contentType) {
  const type = String(contentType ?? "");
  if (type.includes("text/event-stream")) return filterSse(body);
  if (type.includes("application/json")) return filterJson(body);
  return body;
}

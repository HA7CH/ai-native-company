# harness-proxy:第三方模型下的两道边界

来源:第二个 reference deployment(见 `docs/LESSONS-MANUFACTURING-PILOT.md` §2.4)。零依赖,Node ≥ 18。

## 解决什么

角色 bot 走第三方 Anthropic 兼容端点(如 DeepSeek)时,Claude Code 自带的 system prompt 携带「Claude Code」身份,非 Claude 模型倾向服从它而不是 `append_system_prompt` 里的 persona:bot 自称 Claude Code、向员工罗列终端能力。另外,含工具调用的模型轮次会带一句「让我先查一下」,cc-connect 的 `display.mode = "quiet"` 关不掉它。

本代理坐在 harness 与端点之间:

1. **请求侧**:`/v1/messages` 的 `system` 整段替换(默认)或前置为 persona 文件内容;工具定义保留。
2. **响应侧**:含 `tool_use` 的轮次丢弃其 text 块,最终文本轮次原样透传(SSE 与 JSON 两种形态都覆盖)。

## 用法

```bash
ANC_UPSTREAM_BASE_URL=https://<第三方端点> \
ANC_SYSTEM_PROMPT_FILE=/path/to/persona.md \
ANC_PROXY_PORT=19147 \
node tools/harness-proxy/system-prompt-proxy.mjs
```

harness 侧把 `ANTHROPIC_BASE_URL` 指到 `http://127.0.0.1:19147`;鉴权 header 由 harness 自己带,代理不持有凭据。健康检查:`GET /__anc_health`。

只监听 loopback;persona 文件建议 600。用官方 Claude 模型时不需要本代理(persona 经 `append_system_prompt` 即可,见 M1-DESIGN §4)。

## 测试

```bash
npm test   # = node --test tools/harness-proxy/harness-proxy.test.mjs
```

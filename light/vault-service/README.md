# anc-vault:公司共享 vault 服务(轻形态 MVP)

一句话:**全公司的文件(markdown / PDF / JSON)在云上只有一份,每个人的 Claude Code 一行命令连上来,读写立即全员可见,写入自动留历史版本。**

- 存储:Cloudflare R2(一个 bucket = 一家公司)
- 接口:一个 Worker,暴露 MCP 五工具 `vault_list / vault_read / vault_search / vault_write / vault_history`
- 零运行时依赖;鉴权 Bearer token,未配 token 服务全拒(默认值即安全)
- 覆盖写之前旧版自动存 `_history/<path>/<时间戳>`(含 author/reason),可查可回滚;`_history/` 只读

## 部署(每家公司一次,约 5 分钟)

> **自带账号原则**:部署用的是**你们公司自己的 Cloudflare 账号**(没有就去 dash.cloudflare.com 免费注册,并在侧栏开通 R2)。bucket、token、数据全部归公司自己;这是 infra 不是 SaaS——没有中心服务端,本仓库作者不经手、也无法访问任何公司的数据。

```bash
cd light/vault-service
npm ci
npx wrangler login                       # 首次
npx wrangler r2 bucket create anc-vault  # 公司数据桶
npx wrangler secret put VAULT_TOKEN      # 输一个长随机串,这就是公司的钥匙
npx wrangler deploy --name anc-vault-<公司名>
```

产出地址形如 `https://anc-vault-<公司名>.<账号>.workers.dev`。

> 费用:Workers Paid $5/月起;R2 10GB 免费额度内 markdown 规模基本为零。

## 每个成员接入(一行)

```bash
claude mcp add --transport http vault https://<worker地址>/mcp --header "Authorization: Bearer <token>"
```

之后在自己的 Claude Code 里直接问公司的事;建库跑 `anc-onboard`,入库跑 `anc-ingest`(见 `../skills/`)。

## 本地开发与自测

```bash
cp .dev.vars.example .dev.vars   # 填一个测试 token
npm run dev                      # wrangler dev,本地模拟 R2
```

冒烟(另开终端):

```bash
TOKEN=dev-secret-change-me; URL=http://localhost:8787/mcp
# 握手
curl -s $URL -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# 写 → 读 → 搜 → 历史
curl -s $URL -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vault_write","arguments":{"path":"CLAUDE.md","content":"# demo","author":"dev","reason":"smoke"}}}'
```

## 边界(MVP 已知限制,升级路径见 docs/LIGHT-MVP.md)

- 单 token 一家公司,不分成员权限(per-member token / OAuth 是下一步)
- 搜索是逐文件扫描(≤400 文件/15MB/次),量大再上索引;真相永远是 R2 里的文件
- 二进制原件 ≤6MB;断网不可用(要离线,用托管形态的本地 vault)
- 写并发用 etag CAS 保护:两人同时改同一文件,后提交者会收到冲突报错(提示重读合并再写),不会无痕覆盖

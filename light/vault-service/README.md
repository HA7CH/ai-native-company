# anc-vault:公司共享 vault 服务(分层轻形态 v2)

一句话:**全公司的文件在云上只有一份;结构化 markdown 增量同步到每个人本地让 agent 全速 grep,GB 级原件留在云上按需单取,写入自动留历史版本。**

形态选型(有没有大量 PDF → 走 git 还是走本方案)见 [`docs/VAULT-FORMS.md`](../../docs/VAULT-FORMS.md)。核心一句:**MCP 是控制面,不是数据通道**——
agent 逐 token 生成 base64 的真实上限约 100–150 KB,靠它搬 GB 级原件在体量上就不成立。

- 存储:Cloudflare R2(一个 bucket = 一家公司)
- 四条接口:`POST /mcp`(控制面六工具)、`GET /manifest`(增量同步清单)、`GET|PUT /raw/<path>`(流式读写)
- 分层:`index`(文本,同步到本地)/ `originals`(路径含 `_originals` 段,按需取)/ `_history`(只读)
- 零运行时依赖;鉴权 Bearer token,未配 token 服务全拒(默认值即安全)
- 覆盖写强制 `base_etag`(read-before-write),旧版自动存 `_history/<path>/<时间戳>`;`_history/` 只读

## 部署(每家公司一次,约 5 分钟)

> **自带账号原则**:部署用的是**你们公司自己的 Cloudflare 账号**(没有就去 dash.cloudflare.com 免费注册,并在侧栏开通 R2)。bucket、token、数据全部归公司自己;这是 infra 不是 SaaS——没有中心服务端,本仓库作者不经手、也无法访问任何公司的数据。

```bash
cd light/vault-service
npm ci
npx wrangler login                            # 首次
npx wrangler r2 bucket create anc-vault       # 公司数据桶
npx wrangler deploy --name anc-vault-<公司名>  # 先部署:此时未配 token,服务全拒,安全
npx wrangler secret put VAULT_TOKEN --name anc-vault-<公司名>
# ↑ 输一个长随机串,这就是公司的钥匙;--name 必须与部署名一致,否则 secret 会写到别的 Worker、服务恒 401
```

产出地址形如 `https://anc-vault-<公司名>.<账号>.workers.dev`。

> 费用:Workers Paid $5/月起;R2 10GB 免费额度内 markdown 规模基本为零。

## 每个成员接入(两步)

```bash
# 1. MCP 控制面(问事、写入、查原件位置)
claude mcp add --transport http vault https://<worker地址>/mcp --header "Authorization: Bearer <token>"

# 2. 本地镜像(让 agent 用 rg 全速搜,不走网络、不会截断)
node light/cli/anc.mjs init https://<worker地址> <token> --name <公司名>
node light/cli/anc.mjs pull
```

第 2 步只同步结构化 markdown 与 OCR 文本(通常几百 KB 到几 MB),GB 级原件不动,
要看时 `anc open <路径>` 单取。之后 Claude Code 与 Codex 直接在镜像目录里 `rg`/`Read`,
零改造。建库跑 `anc-onboard`,入库跑 `anc-ingest`(见 `../skills/`)。

### 为什么要本地镜像

服务端搜索在大体量下会**静默返回不完整结果**:全局命中行数一封顶就停止扫描,后面的文件
一个字节都没读过,而提示只说「已截断」——使用者会把它当成完整答案。v2 改成按文件配额、
保证命中**面**完整,但本地 `rg` 依然更快、更全、支持正则与上下文。
**服务端搜索是没装 CLI 时的兜底。**

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

## 自测

```bash
npx wrangler dev --port 8799 --local     # 起本地实例(miniflare 模拟 R2)
node ../test/e2e.mjs                     # 44 项:分层/搜索完整性/写报告并发/原件通道/中文/护栏
node ../test/cli-collab.mjs              # 12 项:两个人同时写一份报告的完整链路
```

> e2e 会写入**无法删除**的数据(vault 刻意没有删除接口:员工删不掉,只有管理员能从 R2 侧删)。
> 对着有真实内容的非本地实例跑会被拒绝,除非显式 `--i-know`。

## 边界(已知限制,完整清单见 docs/VAULT-FORMS.md)

- 单 token 一家公司,不分成员权限。需要按项目/密级隔离时**权限边界 = 部署边界**:
  同一份源码多部署一次,另一个桶、另一个 token。per-member token 是下一步
- R2 是唯一一份,`_history` 是版本历史**不是备份**;备份上线前 vault 不能是任何档案的唯一副本
- 扫描件无文字层时 grep 零命中 —— 这在**任何形态下**都成立,要先跑 OCR 生成 `_ocr/` 文本层
- 服务端全量 `/manifest` 需全量 list 后筛;千级键毫秒,十万级键需数秒 —— 到那个量级应把清单物化并增量更新
- **国内网络注意**:`*.workers.dev` 裸域在部分国内网络不可达,生产使用请在 Cloudflare 给 Worker 绑自定义域
- 数据落在 Cloudflare(境外基础设施)。涉个人信息/政府国企底稿/法定保存年限档案时,
  这是**先于技术的决策**;若境外不可接受,换境内对象存储重新部署同一份逻辑

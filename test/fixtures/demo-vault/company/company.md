---
name: Demo Trading Co        # 显示名
id: demo                     # ASCII 前缀:launchd label com.demo.*、project 名前缀
language: zh-CN
timezone: Asia/Shanghai
platform: feishu             # v1 唯一取值
defaults:
  model: claude-sonnet-5
  mode: dontAsk              # 角色 bot 默认权限档
  auto_compress_max_tokens: 120000
admins: [alice]
sync_interval_min: 15
fallback_provider:
  name: cheapfall
  base_url: "https://api.example.com/anthropic"
  model: cheap-model-1
---
一家演示用跨境小商品贸易公司,客户以华东与东南亚为主。常用术语:SKU(最小库存单位)、MOQ(最小起订量)。

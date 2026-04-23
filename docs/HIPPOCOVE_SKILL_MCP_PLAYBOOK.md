# Hippocove Skill / MCP 接入说明

这份是写给两种人看的：

- 要继续接手 Hippocove 的人类开发者
- 要替人类跑步骤、但需要边界清楚的辅助 AI / agent

它不讲宣传口径，主要讲三件事：

1. 这套东西现在哪几步已经能被 agent 驱动
2. 哪几步还卡在 UI 或人工处理
3. 如果要给别的 AI 一个 skill / workflow，它该怎么写才不容易误踩

---

## 1. 先看全局地图

Hippocove 现在不是一张纯网页。

它更像：

`前端页面 + 本地后端 + 本地 scope 存档 + Obsidian 导出`

主链已经大致成形：

`原始记录 -> 入包/切片 -> reviewed -> 人格工位 -> 主卡生长 -> 记忆整编 -> 隐私筛查 -> 导出`

但这条链不是每一站都一样成熟。

- 前半段：更像“后端流水线”，适合 MCP / skill 驱动
- 中段：人格工位、主卡生长，也已经有比较清楚的接口
- 后段：记忆整编已有后端导出接口，但隐私筛查仍然更像“人工最后处理台”

所以现在最稳的理解不是：

> Hippocove 已经是一套纯自动 agent 平台

而是：

> Hippocove 已经有一条可被 agent 接住的大骨架，但最后的整编确认与现实隐私处理，仍然保留人工把关位。

### 1.1 如果别人只是想把这套工位点亮

现在最稳的仓内入口不是让人自己猜 `localhost:3460`，而是直接让他双击仓根目录里对应系统的启动脚本：

- macOS：`00_双击启动_Hippocove.command`
- Windows：`00_双击启动_Hippocove.cmd`

这把钥匙会自动：

- 检查后端依赖
- 拉起本地后端
- 打开前台

如果是辅助 AI 在教人怎么用，这一句已经够稳：

> 先双击仓根目录里对应系统的本地启动脚本，把本地工位点亮；前台跑主流程，旧实验台做整编和隐私筛查。

---

## 2. 缓存、运行时、导出到底放哪

### 2.1 代码目录

- 项目根：`/Users/mac/Documents/Codex/0-github/202604-Hippocove`

### 2.2 运行时 / 缓存 / 用户数据

这些都不跟代码混在一起，主根在：

- `data/runtime_save`

更具体一点：

- `data/runtime_save/truth_layer/scopes/<owner>/<realm>/...`
- `data/runtime_save/ui_api_profiles.json`
- `data/runtime_save/ui_api_config.json`

### 2.3 导出目录

- `output/obsidian_staging`

每个 scope 会再分到自己的子目录里：

- `output/obsidian_staging/<owner>__<realm>`

### 2.4 这一层是否可以清空

可以。

如果只是想清掉：

- 提取后的缓存
- scope 运行态
- 导出的记忆包
- 本地 API 方案

这些都在代码目录之外的独立数据区，不会直接伤到源码本身。

对应代码入口：

- `server/core/path-config.js`
- `server/core/runtime-api-profile-store.js`

---

## 3. 哪几步已经适合 agent 驱动

这一段最重要。

### 3.1 已经有 MCP 工具、适合直接给 agent 的部分

入口：

- `server/mcp-server.js`
- `server/core/mcp-tool-service.js`

现成 MCP 工具包括：

- `list_api_profiles`
- `get_persona_workspace_state`
- `save_persona_workspace_state`
- `build_language_fingerprint_candidates`
- `generate_soul_draft`
- `generate_language_fingerprint`
- `get_growth_context`
- `build_growth_task`
- `generate_growth_draft`
- `list_growth_drafts`
- `get_growth_draft`
- `export_growth_draft_to_obsidian`
- `get_card_registry`
- `upsert_card_registry_entry`
- `get_growth_ledger`
- `append_growth_ledger_entry`
- `commit_growth_decision`
- `run_history_pipeline`
- `prepare_history_source`
- `pull_translation_task`
- `submit_translation_entries`
- `fail_translation_task`
- `list_reviewed_clusters`
- `finalize_reviewed_entries`
- `inspect_pipeline_scope`
- `get_memory_context`

如果只是想让 agent 跑下面这些事，已经是顺手的：

- 准备原始记录
- 拉取下一张提炼任务
- 写回 reviewed
- finalize 到 truth layer
- 读/写人格工位
- 生成主卡草稿
- 看 registry / ledger
- 导出单张草稿到 Obsidian staging

### 3.2 已经有后端接口、但还没有专门 MCP tool 的部分

这一层已经能通过 HTTP 路由调用，但还没长成独立 MCP 工具：

- `GET /api/runtime/memo-compact`
- `POST /api/runtime/memo-compact/export`
- `POST /api/runtime/obsidian-export/bundle`
- `POST /api/runtime/growth-runtime/start`
- `POST /api/runtime/growth-runtime/pause`
- `POST /api/runtime/growth-runtime/resume`
- `POST /api/runtime/parse-runtime/start`
- `POST /api/runtime/parse-runtime/pause`
- `POST /api/runtime/parse-runtime/resume`

这意味着：

- 它们**可以**被 wrapper skill / agent 调
- 但现在更像“API 能力”，还不是“文档齐、边界清楚、直接给外部 agent 的成熟工具”

### 3.3 目前还不适合直接当成 MCP 工具的部分

当前最不适合直接让 agent 独走的是：

- `隐私筛查`

原因不是它没用，而是它现在还保留了明显的页面态：

- 风险条目整理、焦点切换、手动编辑，主要还在 `legacy/index.html`
- 自动打码和“保存修改”会影响当前页面态与导出结果，但缺少一条独立、稳定、可复用的后端合同
- 也就是说，它更像“人工处理台”，还不像“独立后端服务”

一句人话总结：

> 现在让 agent 跑到“整编预览 / 整编导出”已经没问题；让 agent 独自处理“最后的现实隐私裁剪”，还太早。

---

## 4. 给辅助 AI 的推荐分工

如果你要给别的辅助 AI 写 skill，最稳的分工是：

- 代码 / 工具：负责搬运、缓存、分片、导出、记账
- 模型：负责判断、提炼、写正文
- 人：负责最后的价值判断和现实隐私裁剪

别把 skill 写成：

> “你看着办，把整套都自动跑完”

更稳的是写成：

> “你推进到整编包为止；如果涉及现实世界隐私，就停在隐私筛查前，把结果交回人类。”

---

## 5. 推荐的 Skill 写法

下面这段不是唯一模板，但已经够给别的辅助 AI 当工作说明。

```md
# Hippocove Operator

你在 Hippocove 里不是网页用户，而是流程操作员。

你的目标：
- 优先使用现有 MCP 工具和 runtime 路由
- 不重复重看全量原始记录
- 不自己发明新的落盘路径
- 把流程推进到“可交付整编包”或“需要人类最后裁决”的位置

工作顺序：
1. 先确认 owner_id / realm_id
2. 用 inspect_pipeline_scope 看 scope 落到哪
3. 如果原始记录还没入包，用 prepare_history_source 或 run_history_pipeline
4. 如果是翻译/提炼阶段，用 pull_translation_task -> submit_translation_entries / fail_translation_task
5. 如果是人格工位阶段，用 get_persona_workspace_state / save_persona_workspace_state / generate_soul_draft / generate_language_fingerprint
6. 如果是主卡阶段，用 get_growth_context -> build_growth_task -> generate_growth_draft
7. 如果要导出单卡，用 export_growth_draft_to_obsidian
8. 如果要导出整编包，改走 runtime memo-compact 路由
9. 如果发现现实世界隐私，不擅自发布最终包，把结果交回人工在隐私筛查页处理

硬边界：
- 不把网页按钮当成唯一真相，优先以后端 scope 和 packet 为准
- 不假设 GitHub Pages 就能代替本地后端
- 不把“隐私筛查 UI”当成成熟 MCP 工具
- 不绕开 registry / ledger 自己写临时文件当正式记账
```

这类 skill 最适合：

- Codex
- Claude Code
- 任何能挂本地 MCP 的 agent 壳

不太适合：

- 纯聊天网页
- 只会发一轮消息、不会调本地工具的“API 对话页”

---

## 6. 当前路由地图

### 6.1 运行时 UI / 工作台主路

集中在：

- `server/routes/product/runtime-persona-workspace.js`

这个文件现在承担的事情很多：

- 人格工位
- workbench cache
- growth context / task / draft
- growth runtime start/pause/resume
- parse runtime start/pause/resume
- dashboard / staging
- Obsidian 导出
- memo compact 导出

它是现在最明显的一根“大总线”。

### 6.2 路由总目录

看这里：

- `server/routes/registry.js`

对外最有用的一组，是 `runtime-ui` 这一组。

### 6.3 Legacy 页面

- `legacy/index.html`

它仍然承担不少真实工作，尤其是：

- 记忆整编 UI
- 隐私筛查 UI
- 最后的人工处理动作

这也意味着：

> 旧实验台并不只是“旧界面”，它现在还是一部分真实业务逻辑的承载面。

---

## 7. 当前的“屎山 / 断头”核查结果

这里不拐弯，直接说最危险的几个点。

### 7.1 最大的屎山：`legacy/index.html`

- 文件体量：`22694` 行
- 它已经不是单纯模板页，而是：
  - 样式
  - 状态机
  - 数据整理
  - 风险判断
  - 导出动作
  - 局部业务规则
  全都揉在一起

这意味着：

- UI 改动会很容易碰到业务
- 业务修补也很容易顺手长成 UI patch
- 隐私筛查、整编、导出之间的边界不够硬

### 7.2 最大的“断头总线”：`runtime-persona-workspace.js`

- 文件体量：`596` 行
- 它现在把太多 runtime 路由捏在一个 handler 里

短期它还能跑，长期问题是：

- 任意一站加功能，都容易把别站一起带脏
- 很难给外部 agent 说清“这条路只是做 A，不会顺手做 B”

### 7.3 记忆整编已后端化，但隐私处理还没完全后端化

- `memo-compact` 已有清楚的后端 packet/export
- `隐私筛查` 仍然大量靠 `legacy/index.html` 的前端状态和编辑逻辑

这就是当前最典型的“半截桥”：

- 前面是合同
- 后面还是工作台

### 7.4 MCP 和 runtime route 之间还有一道缝

已经有 MCP 的：

- 人格工位
- growth task / draft
- translation / reviewed

还只有 HTTP route、没有对应 MCP tool 的：

- `memo-compact` 预览与导出
- clean export / 无隐私导出

这导致：

- 页面能做的事，不一定等价于 agent 能直接做的事

### 7.5 分享形态和真实架构还没对齐

页面看起来像“给人打开就能用”；
真实结构却是：

- 同源本地后端
- 本地 scope 存档
- 本地导出目录

这就是为什么它总给人一种“网页开着，但脑子还得重启”的感觉。

---

## 8. 现在如果要继续拆，优先顺序是什么

如果以后继续修，最值钱的顺序是：

### 第一刀

把这些变成正式 MCP / service：

- `get_memo_compact_preview`
- `export_memo_compact_bundle`

### 第二刀

把隐私筛查从页面态里再拆出一条真正的后端合同：

- `scan_compact_privacy`
- `apply_privacy_redaction`
- `export_clean_compact_bundle`

### 第三刀

再考虑把 legacy 里那块最终人工台，收成更小的 UI。

也就是说：

先拆后端合同，
再瘦页面，
别反过来。

---

## 9. 为什么 GitHub 网页现在不能直接给别人用

短答案：

**不能只靠 GitHub Pages。**

原因很简单：

### 9.1 页面依赖同源后端

前台和旧实验台都直接请求：

- `/api/runtime/persona-workspace`
- `/api/runtime/growth-dashboard`
- `/api/runtime/growth-runtime`
- `/api/runtime/parse-runtime`
- `/api/runtime/memo-compact`
- `/api/runtime/memo-compact/export`

这些都不是静态网页能自己提供的。

### 9.2 它依赖可写本地磁盘

Hippocove 运行时会写：

- `data/runtime_save/...`
- `output/obsidian_staging/...`

GitHub Pages 只会发静态文件，不会给你本地可写 scope。

### 9.3 它依赖本地进程

现在真实运行入口不是“打开 html 文件”，而是：

- 启动本地 Node 后端
- 页面通过同源 API 跟这只进程对话

所以：

> 上传 GitHub 可以分享代码，
> 但不等于别人点开网页就能跑完整工作流。

### 9.4 如果真要给别人用，正确方向是什么

有两条像样的路：

#### 路一：把它做成真正的服务

- 前端部署到 web
- 后端部署到可运行 Node 的服务
- scope / 导出目录改成服务端存储

#### 路二：把它做成真正的本地应用

- 打包成桌面 app 或带守护后端的本地工作台
- 用户只看到“打开应用”
- 不再需要自己理解 `localhost:3460`

在这两条路之外，
“只传 GitHub 页面链接”会像只把皮给出去，骨头和器官还留在本地。

---

## 10. 一句话交底

Hippocove 现在最适合被理解成：

> 一套已经跑通主链、适合被 agent 接住大部分中段流程、但仍保留人工最终把关位的本地记忆工作台。

它已经不是玩具；
但也还不是“扔到 GitHub Pages 就能给陌生人直接用”的纯网页产品。

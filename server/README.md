# Hippocove Backend

这只后端不是“又一层包装”。

它更像一间后厨：前台、旧实验台、MCP、agent，最后都应该通过这里读同一张桌子、写同一套账本。

## 这只后端负责什么

它主要负责四件事：

- 接住原始材料
- 管住中间层缓存与 reviewed
- 给人格工位和主卡生长提供统一状态
- 把草稿、账本和导出落到稳定目录

换句话说：

- 页面负责展示和点按
- AI 负责看和写
- 后端负责把桌子摆好，别让上下文失忆

## 入口

默认启动后，会同时提供：

- `/`
  - 正式前台
- `/legacy/index.html`
  - 旧实验台
- `/api/*`
  - runtime / growth / export / memory 相关接口

## 公开版里最重要的几条主路

### 1. 人格工位

- `GET /api/runtime/persona-workspace`
- `POST /api/runtime/persona-workspace`
- `POST /api/runtime/persona-workspace/cache`
- `POST /api/runtime/persona-workspace/candidate-pool`
- `POST /api/runtime/persona-workspace/generate-soul`
- `POST /api/runtime/persona-workspace/generate-language-fingerprint`

这条线负责：

- `char / user`
- `soul`
- `语言指纹`
- Persona 缓存

### 2. 主卡生长

- `GET /api/runtime/growth-context`
- `GET /api/runtime/growth-task`
- `GET /api/runtime/growth-dashboard`
- `GET /api/runtime/card-registry`
- `GET /api/runtime/growth-ledger`
- `GET /api/runtime/growth-drafts`
- `GET /api/runtime/growth-draft`
- `POST /api/runtime/growth-generate`
- `POST /api/runtime/growth-commit`
- `POST /api/runtime/growth-draft/review`
- `POST /api/runtime/growth-drafts/clear`
- `POST /api/runtime/staging-cards/clear`
- `POST /api/runtime/obsidian-export`

这条线负责：

- growth task
- growth draft
- card registry
- growth ledger
- Trace / discard report / human review
- Obsidian staging export

### 3. 原始材料主链

- `POST /api/memory/ingest`
- `POST /api/memory/translate`
- `POST /api/memory/translate/prepare`
- `POST /api/memory/runtime/task/run`
- `POST /api/memory/reviewed/append`
- `POST /api/memory/reviewed/finalize`

这条线负责：

- 原始记录进缓存
- translation task
- reviewed 中间层
- 去冗余与正式写入前收口

### 4. 读侧与回场

- `GET /api/memory/overview`
- `GET /api/memory/scopes`
- `GET /api/memory/scope`
- `GET /api/memory/search`
- `GET /api/memory/root`
- `GET /api/memory/context`
- `GET /api/memory/home`
- `GET /api/memory/entry`
- `GET /api/memory/shadow`
- `GET /api/memory/audit/recall`

这条线负责：

- bay 总览
- root/context/shadow
- 召回自检

## 旧实验台为什么还保留

因为它不是纯历史页面。

它对调参和识别很有用：

- 每一批结果还是明文的
- 人格卡、语言指纹、批次缓存都能直接看
- 对后来接手的人更友好

如果正式前台像入口台，旧实验台更像调音室。

## 本地运行

```bash
cd server
npm install
npm run start
```

默认地址：

- [http://127.0.0.1:3460/](http://127.0.0.1:3460/)

## MCP

```bash
cd server
npm run mcp
```

MCP 入口文件：

- `mcp-server.js`

这层不是为了把页面自动化，而是为了让支持 MCP 的 agent 直接拿到：

- 人格工位状态
- growth task
- growth draft
- card registry / ledger
- export 能力

## 环境变量

公开版不再假定你的目录结构和作者机器一样。

最常用的是：

- `HIPPOCOVE_STAGE_DROPBOX`
  - 你的输入材料 / stage dropbox 根目录
- `HIPPOCOVE_OBSIDIAN_ROOT`
  - 你的 Obsidian staging 根目录

如果不设，项目会优先使用仓内相对路径和示例目录。

## 这份公开版故意没带什么

为了让仓库更像工作台，而不是施工现场，这份公开版没有继续保留那一大排内部 smoke 脚本和私有问答实验残留。

保留下来的，是能让别人继续接着做的主链：

- ingest / reviewed / growth / export
- 旧实验台
- MCP
- 技术交底与 Pages 文档

如果你要继续长它，先读：

- [../README.md](../README.md)
- [../PROJECT_STATUS.md](../PROJECT_STATUS.md)
- [../docs/HIPPOCOVE_TECH_HANDOFF.md](../docs/HIPPOCOVE_TECH_HANDOFF.md)

# Hippocove MCP Agent Handoff

这份说明不是写给网页用户的。

它是给能调用工具的 agent 用的，比如：

- Codex
- Claude Code
- 本地支持 MCP 的 OpenClaw / OpenHands / 自建 agent 壳

目标很简单：

- 代码负责缓存、分片、排队、写回
- 远端 AI 自己负责读任务、判断、提炼、合并
- 这样就不用每次把整包原始记录从头重看

## 1. 能不能直接接“API 对话端”

分两种情况：

- 如果只是普通的 OpenAI-compatible chat 接口：
  - 不能直接接 `stdio MCP`
  - 这种接口只会收消息，不会自己调用本地工具
  - 需要一个外层 wrapper，替它把“工具调用”翻译成本地进程调用
- 如果是支持 MCP / tools / local tool runtime 的 agent：
  - 可以直接接
  - 这是当前最推荐的形态

所以现在最顺手的不是“单纯 API 对话页”，而是：

- 一个本地 agent 壳
- 背后挂 Hippocove MCP
- 远端模型只负责思考，不负责搬运和落盘

## 2. 启动方式

Hippocove 的 MCP 入口在：

- `server/mcp-server.js`

本地启动：

```bash
cd server
npm run mcp
```

等价命令：

```bash
node server/mcp-server.js
```

## 3. 给 agent 的 MCP 配置

通用思路是把这只本地进程注册成一个 `hippocove` 工具源。

示例：

```json
{
  "mcpServers": {
    "hippocove": {
      "command": "node",
      "args": ["server/mcp-server.js"]
    }
  }
}
```

## 4. 现在可用的工具

### 基础观察

- `list_api_profiles`
  - 列出本地已保存方案
  - 不返回真实密钥，只返回 `has_api_key`
- `inspect_pipeline_scope`
  - 看当前 scope 跑到哪一站
- `get_memory_context`
  - 不翻全库，直接取紧凑上下文

### 一键快检

- `run_history_pipeline`
  - 一次性从原始记录跑到最终写回
  - 更适合：
    - 烟雾测试
    - 小样本验收
    - 本地快检

### 真正给远端 AI 接力的分步工具

- `prepare_history_source`
  - 把原始记录送进缓存
  - 自动做时间拼装、分片、批任务准备
- `pull_translation_task`
  - 取出下一条待处理任务
  - 返回 `slices`、`ai_contract`、`summary`
- `submit_translation_entries`
  - 把 AI 提炼好的 `entries` 写回 reviewed
- `fail_translation_task`
  - 当前任务不适合安全提炼时，显式标失败
- `list_reviewed_clusters`
  - 查看 reviewed 的 cluster
  - 给 AI 判断哪些需要进一步语义合并
- `finalize_reviewed_entries`
  - 把 reviewed 最终写回 roots / vines

## 5. 推荐工作流

真正适合长期跑的路线不是一键到底，而是这条：

1. `prepare_history_source`
2. `pull_translation_task`
3. 远端 AI 读取 `ai_contract + slices`
4. AI 产出 `entries`
5. `submit_translation_entries`
6. 重复 2-5，直到没有待处理任务
7. `list_reviewed_clusters`
8. 如有需要，AI 做语义合并
9. `finalize_reviewed_entries`

这条路的好处是：

- 中间产物都在本地缓存
- 任何一步断掉，都能从 scope 继续
- 换模型、换试用 token、换 agent 壳，都不用重跑最前面

## 6. 断点续传怎么理解

这套系统的断点，不靠“聊天上下文记得没记得”，而靠本地 scope。

scope 下面会留下：

- ingest packet
- translation packet
- task packet
- reviewed packet
- final writeback

所以只要 `owner_id + realm_id` 不换，远端 AI 下一次回来还能接着干。

推荐做法：

- 一个“月包 / 窗口包”对应一个固定 `realm_id`
- 不要每次重开都换 scope
- 先用便宜或试用 token 跑提炼
- 后面真要细磨某一步，再单独换模型继续

## 7. 关于试用 token

这套结构很适合你说的那种“各家送一点试用 token，拼起来跑”：

- 提炼阶段可以换模型
- reviewed 合并阶段也可以换模型
- finalize 不依赖外部模型

只要前面的 packet 和 tasks 已经落下来，后面谁来接都行。

所以便宜模型 / 试用模型不一定要跑完整链，只要它能接住某一站，就有价值。

## 8. 对 agent 的行为约束

如果让远端 AI 自己推进，最好明确告诉它：

- 不要重看全量原始记录
- 优先用 `pull_translation_task` 取当前任务
- 只根据当前 task packet 产出 entries
- 如果任务是写 Memo，必须从内位视角落笔：我在里面，不在外面观察或解释
- 不要自己发明新的落盘路径
- 所有写回都通过 `submit_translation_entries` 或 `finalize_reviewed_entries`
- 如果当前 task 不适合安全提炼，用 `fail_translation_task`

对于写作型任务，推荐把这句直接写进任务合同：

- “不是只要第一人称，而是要从内位视角写：人在里面经历，不在外面总结。”

## 9. 当前最适合接入的对象

最适合直接接入的是：

- Codex
- Claude Code
- 本地支持 MCP 的 agent 壳

不太适合“直接裸接”的是：

- 纯聊天网页
- 只支持单轮消息、没有工具运行时的 API 对话端

那类如果硬接，还是会退回“人肉贴材料、AI 肉眼重读”的老路。

## 10. 一句话总结

Hippocove 现在最适合被当成：

- 一个本地记忆流水线工具箱
- 而不是一个自己思考的 API 中间商

代码管搬运和缓存，
AI 管判断和生成，
这就是当前最稳的分工。

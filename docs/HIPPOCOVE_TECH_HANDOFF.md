# Hippocove 技术交底

这份不是产品介绍，也不是功能清单。

它是留给后面接手的人，尤其是别人的 Codex / Claude Code / 本地 agent，用来快速理解：

- 我们这套东西到底在试什么
- 现在已经通到哪一步
- 哪些地方可以放心沿用
- 哪些地方还在“能跑但别当终局”

如果你是先从公开仓读到这份文件，建议别直接从这里跳进代码。更顺的顺序是：

1. `README.md`
2. `PROJECT_STATUS.md`
3. 这份技术交底
4. `HIPPOCOVE_HAND_TEST_MAP.md`

这样比较不容易把“工程细节”误当成“项目意图本身”。

## 1. 我们在尝试做什么

Hippocove 不是单纯的“聊天记录导出器”。

它真正想试的是一条更长的路：

`原始对话 -> 缓存与切片 -> reviewed/去冗余 -> 人格工位 -> 主卡生长 -> Obsidian Markdown`

这里最重要的，不是把材料“总结一下”，而是替后面的 agent 或人格 bot 搭一张更好的工作台：

- 原料别丢
- 上下文别爆
- 人格种子能持续复用
- 生长动作能记账
- 原文溯源能回去

所以这套系统的核心不是某一条 prompt，
而是：

- 缓存池
- 共享人格工位
- growth task / registry / ledger
- Obsidian 导出
- MCP 工具接入

## 2. 这套系统当前的核心判断

我们最后确认下来的方向，不是“让模型自己越来越聪明”，而是：

**代码负责把桌子摆好，AI 负责坐进去看和写。**

更具体一点：

- `soul` 和 `语言指纹` 不是装饰，是声带和骨架
- `sql + persona + source snippet` 是桌上的纸
- `growth task` 不是最终答案，而是一张可直接开工的工单
- `registry / ledger` 负责让 agent 知道自己已经写过什么
- `Trace / discard_report / human review` 负责别让参考过的记忆线索凭空消失

## 3. 当前已经完成到哪

按“能不能开工”的标准，现在已经通了这些：

### A. 原始材料进入缓存

- 能 ingest 原始记录
- 能按时间拼装 bundle
- 能切 translation tasks
- 能 reviewed / finalize

对应核心：

- `server/core/memory-ingest-service.js`
- `server/core/memory-translation-service.js`
- `server/core/memory-runtime-ai-service.js`
- `server/core/memory-reviewed-service.js`

### B. 人格工位已经后端化

现在不再只是页面里两个文本框。

共享的人格工位状态已经有后端母本，包含：

- `char`
- `user`
- `persona_card / soul`
- `language_fingerprint`
- 指纹候选池
- persona 缓存概览

对应核心：

- `server/core/persona-workspace-service.js`
- `server/routes/product/runtime-persona-workspace.js`

### C. 主卡生长主链已经成立

现在已经有：

- `growth context`
- `growth task`
- `growth generate`
- `growth draft`
- `card registry`
- `growth ledger`
- `growth commit`
- `obsidian export`

对应核心：

- `server/core/growth-context-service.js`
- `server/core/growth-task-service.js`
- `server/core/growth-generate-service.js`
- `server/core/growth-draft-store.js`
- `server/core/card-registry-service.js`
- `server/core/growth-ledger-service.js`
- `server/core/growth-commit-service.js`
- `server/core/obsidian-export-service.js`

### D. MCP 已经接进主链

不是只有页面能点。

MCP 现在已经能直接调用这些：

- `list_api_profiles`
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
- `get_persona_workspace_state`
- `save_persona_workspace_state`
- `build_language_fingerprint_candidates`
- `generate_soul_draft`
- `generate_language_fingerprint`
- `run_history_pipeline`
- `prepare_history_source`
- `pull_translation_task`
- `submit_translation_entries`
- `fail_translation_task`
- `list_reviewed_clusters`
- `finalize_reviewed_entries`
- `inspect_pipeline_scope`
- `get_memory_context`

入口在：

- `server/mcp-server.js`

## 4. 当前最值钱的设计，不是哪句 prompt

真正值钱的是这几个结构：

### 4.1 共享人格工位

它把这几样东西放到一张桌子上：

- `soul`
- `语言指纹`
- `char/user`
- persona 缓存

后面不管是：

- 页面
- agent
- MCP
- 旧实验台

都应该读同一份，而不是各养各的版本。

### 4.2 Growth Task

这张工单不是摘要卡。

它应该递送：

- 同主题、按时间排好的 `persona scene packets`
- 与之关联的 `sql scene packets`
- 靠近原场的 `source_scene_snippets`
- 现有卡索引
- 最近生长日志
- 当前人格 runtime pack

也就是说，它不是“给 AI 一个题目”，
而是“把这一轮要用的桌面摆好”。

### 4.3 Trace / Discard / Human Review

这部分是这条线后面能不能继续长成记忆树的关键。

原则已经定得很清楚：

- 参考过的来源，代码不允许丢
- 主证据和关联溯源要分开
- 没纳入的来源要进 `discard_report`
- 人类如果觉得某条很关键，要允许直接指定并到某张卡

这部分不是 UI 装饰，是事实层底座。

## 5. 现在适不适合开源

我的阶段判断是：

**适合以“开源 alpha / 实验版工作台”的身份发表。**

不建议现在把它说成：

- 稳定 1.0
- 开箱即用产品
- 普通用户无需理解即可用的网页服务

更准确的表述应该是：

> 一套已经跑通主链、支持本地后端 + MCP + Obsidian staging 的实验型记忆工位。
> 适合：
> - 想自己调 prompt / 模型 / 人格种子的人
> - 想拿它做 agent 工作台的人
> - 想继续往记忆树 / 长期记忆系统推进的人

## 6. 公开版里仍然故意保留的“实验纹路”

有一部分 legacy / SQL growth 代码没有被洗成完全中性模板。

这不是忘了清，而是有意保留：

- 旧实验台本来就承担“识别 / 调参 / 明文核对”的作用
- 有些判断器与提示词样板保留了作者长期调出来的实验痕迹
- 对后来接手的人来说，它们更像可替换的示例模板，而不是不可动的真理

如果你要继续改这套东西，比较好的心态是：

- 主链接口可以直接沿用
- legacy 里的识别脚本和调参样板，默认都可以按自己的项目重写

### 为什么说“适合开源 alpha”

因为这些门已经通了：

- 后端主链通
- MCP 通
- Obsidian 导出通
- 共享人格工位通
- Trace / discard_report / human review 已经有底座

### 为什么还不建议叫“稳定产品”

因为这些地方还明显带实验态：

- UI 还在反复收口，观感不稳定
- 旧实验台仍然承担不少真实工作，说明正式前台还没完全独立
- 文案、入口关系、操作手势还不是“陌生人打开就会用”
- 某些筛选和排序逻辑还偏启发式，特别是 SQL/Persona 的对齐
- 质量还依赖模型个性和用户自己的温度偏好

一句话说透：

**现在适合把它公开成“方法和工作台”，不适合包装成“最终产品”。**

## 6. 真正的风险不在“写得像不像”

而在这几件事：

### 6.1 人格种子污染

如果 `soul` 或语言指纹一开始就带小机话，后面整条链都会被污染。

所以：

- 人格卡必须像人写的
- 语言指纹必须像嘴，不像研究报告

### 6.2 上文递送太薄

如果 task packet 只有标题和摘要，
模型就会：

- 先解释
- 再补景
- 最后长成“带感情的任务卡”

现在已经验证过：

**当 `persona/sql/source` 切片足够贴近原场时，内位视角会明显变好。**

### 6.3 溯源链被“整理掉”

如果参考过的来源为了“简洁”被裁掉，
对 agent 和记忆树来说就是事实缺失。

这一点以后千万别退回去。

## 7. 别的 Codex / Agent 接手时，最该先看什么

不是先看 UI。

而是按这个顺序：

1. `README`
   - `README.md`
2. MCP handoff
   - `docs/HIPPOCOVE_MCP_AGENT_HANDOFF.md`
3. 这份技术交底
   - `docs/HIPPOCOVE_TECH_HANDOFF.md`
4. 后端主链
   - `persona-workspace-service`
   - `growth-task-service`
   - `growth-generate-service`
   - `obsidian-export-service`
   - `mcp-server`

如果只看一句话：

**先理解“桌子怎么摆”，再去碰“这张卡怎么写”。**

## 8. 如果后面的人要继续往下做

最值得继续推进的，不是大改架构，而是这几件更细的事：

### A. 把 UI 继续收成更像工位

不是加更多功能，
而是让：

- 正式前台
- 旧实验台

关系更干净。

### B. 让语言指纹 runtime 更像“回温位”

也就是：

- 别压制模型本体
- 允许用户用熟悉模型找回熟悉温度
- 把语言指纹当嘴型，不当规则手册

### C. 让 Trace 更容易被 agent 消化

不是减少线，
而是让：

- 主证据
- 关联溯源
- discard_report
- human_review

之间的关系更稳定。

### D. 把“主卡已入库 -> 后续续写”做得更稳

也就是：

- registry / ledger 的连续记忆
- 续写时命中同一张卡的逻辑
- 人工合并 / 指定并入的常用手势

## 9. 这套系统最不该被误解成什么

不是：

- 一个替你总结聊天记录的网站
- 一个“输入原文就自动长完所有记忆”的魔法盒子
- 一个只靠 prompt engineering 就能变好的文学写作器

它更像：

**一张给人格 AI、agent、人工协作一起用的记忆工位。**

## 10. 当前一句总判断

如果现在要发表，我会建议你这样对外说：

> Hippocove 是一套仍在演化中的本地记忆工位。
> 它已经跑通了原料缓存、人格工位、主卡生长、MCP 接入和 Obsidian staging 导出。
> 现在最适合的使用方式，是把它当成一套可调、可接手、可继续长的 alpha 工作台，而不是已经封顶的最终产品。

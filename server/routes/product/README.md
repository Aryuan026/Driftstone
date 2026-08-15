# Product Routes

这里放 Driftstone 当前还会被本地前台或 agent 调用的后端入口。

公开产品的最终真相不是旧 `roots/vines` 写入层，而是后续要收口到：

```text
portable_warm_bundle + manifest + source occurrence/span/digest + rejected/HOLD ledger
```

主要包括：

- 读：
  - `memory-read.js`
- 采集、任务与兼容推进：
  - `memory-ingest.js`
  - `memory-translate.js`
  - `memory-translation-tasks.js`
  - `memory-advance.js`

- 旧兼容写入：
  - `memory-write.js`

`memory-write.js` 目前仍服务旧 roots/vines 兼容层。它不能被新的公开
Driftstone agent 当作最终可移植 Warm bundle 出口。

判断标准很简单：

- 如果这是新前厅会直接用到的主路或仍需保留的兼容路，就放这里
- 如果它更像审计、修补或开发验证工位，就不放这里

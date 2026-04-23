# Product Routes

这里放 `hippocove` 当前准备继续带到产品面的后端入口。

主要包括：

- 读：
  - `memory-read.js`
- 写与推进：
  - `memory-ingest.js`
  - `memory-translate.js`
  - `memory-translation-tasks.js`
  - `memory-write.js`
  - `memory-advance.js`

判断标准很简单：

- 如果这是新前厅会直接用到的主路，就放这里
- 如果它更像审计、修补或开发验证工位，就不放这里

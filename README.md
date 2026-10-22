# pi-memory

给 [pi](https://github.com/earendil-works/pi) 的**会话长期记忆**：自动保存每次对话，支持中文 / 英文 / 中英混排的关键词检索，供模型和你在以后按需查回。

和笔记型记忆插件（手动 `memory_write` 写 MEMORY.md）不同，这个插件**不要求任何人主动记什么** —— 它捕获 `message_end`，把消息渲染成 markdown 落进自己拥有的 SQLite 库。删掉 pi 的 `sessions/*.jsonl` 也不影响它。

零依赖：只用 `node:sqlite` + FTS5（Node ≥ 22.19，pi 本身的要求）。

## 安装

```bash
pi install /path/to/pi-memory
```

或开发时直接挂：

```bash
pi --extension ./index.ts
```

## 用法

模型侧：

- `session_search({ query })` —— 搜历史。用户说「上次」「之前」「我们讨论过」时会触发。
- `session_read({ session_id, around_msg_id })` —— 读出命中点前后的连续对话。

你侧：

```
/recall 缓存索引          查
/recall stats            库有多大、多少条
/recall import           把已有 sessions/*.jsonl 一次性导入（分批，不卡 UI）
```

## 它怎么工作

```
message_end         ─┐
session_start        │
session_compact      ├─→ 渲染 markdown ─→ 脱敏 ─→ SQLite(WAL) ─→ 双通道 FTS5
session_shutdown    ─┘                                        ↑
                                        session_search / session_read / /recall
```

`session_search` 是三阶段检索：

1. 分词：中文单字 + 双字两路，拉丁词两路都用
2. 用**最稀有的 3 个单字**做锚点召回（`ORDER BY rowid DESC` 让 FTS5 早停）
3. 双字覆盖率打分，时间做 tiebreak

不这么做的话，中文长查询会直接 0 命中（全部 bigram AND 等价于精确短语匹配），而 OR 又会被高频字挤爆候选窗口。这些数字都在 [DESIGN.md](DESIGN.md) 里，用真实语料（17.8M 字符）测的。

## 性能（实测，29.5k 条消息 / 95MB 库）

| 操作 | 耗时 |
|---|---|
| 写入一条消息 | 0.53 ms |
| 检索（K=200 候选） | 5–15 ms |
| 读 21 条上下文 | 0.06 ms |
| 并发第二个 pi 进程写入 | 1.2 ms |

查询耗时由候选窗口 K 决定，**不随库增长**。

## 数据在哪

```
~/.pi/memory/sessions.db
```

可用 `PI_MEMORY_DB` 改路径，`PI_MEMORY_SESSIONS_DIR` 改导入源。

| 存 | 不存 |
|---|---|
| user 消息 | system prompt |
| assistant 文本 | thinking |
| assistant 工具调用（名称 + 参数） | 成功的 toolResult |
| 失败的 toolResult（前 500 字） | 图片二进制 |
| compaction 摘要 | |

写盘前**不做任何脱敏** —— 这是本地私有库，打码会让内容不可搜。

> ⚠️ 因此 `~/.pi/memory/sessions.db` 里会有你贴过的全部内容，包括密钥。请把它当敏感文件：不要提交、不要同步到公开位置。

## 已知局限

1. 繁简不归一：繁体查询搜不到简体内容。
2. 无词典分词：精确短语能力弱于真分词器；靠稀有字锚点召回 + 双字打分弥补。
3. 插件未加载期间的会话不会被捕获 —— 用 `/recall import` 补。
4. 库本身会被删除；建议纳入备份。
5. 只做关键词检索，没有向量语义检索（v2）。

## 开发

```bash
node --test test/unit.test.ts     # 40 个单元测试，无需 pi、无需模型
node --no-warnings bench/smoke.ts # 接线冒烟：mock ExtensionAPI 跑完整写入+检索
node --no-warnings bench/replay.ts # 用真实 sessions/*.jsonl 回放并测延迟
```

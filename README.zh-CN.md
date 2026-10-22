# pi-memory-sessions

给你的 **pi 历史会话**做关键词检索 —— 中文、英文、中英混排都能搜。

pi 跑过的每一次对话都会被捕获进这个扩展自己拥有的 SQLite 索引里。删掉 pi 的 `sessions/*.jsonl` 也照样能搜。问一句"上个月我们那个 X 是怎么定的"，模型是真的能查出来，因为它有得查。

零运行时依赖：只用 Node 内置的 `node:sqlite` + FTS5。

```text
你 ▸ /recall 缓存索引
     命中 8 条（2.4ms）
     [2026-10-15 14:02 · 3 周前 · ~/code/api · "cache sharding"]
       #122 assistant msg_id=5541 score=1.00
         …按会话分片，索引写在 WAL 之后…【缓存】索引…
```

## 这是什么 / 不是什么

| | |
|---|---|
| **是** | 自动、无损地保存会话记录，可按关键词检索 |
| **不是** | 笔记型记忆（`MEMORY.md`）。这里没有人工策展、没有摘要、不往 system prompt 里注入任何东西 |
| **不是** | 语义/向量检索。只做关键词（[原因](#为什么不用向量检索)） |

如果你要的是"让 agent 记住一个偏好"，那是策展笔记该解决的问题。这个项目解决另一半：**找回到底发生过什么**。

## 运行要求

- pi ≥ 1.0
- **Node ≥ 22.19** —— 因为要用 `node:sqlite`
- SQLite ≥ 3.43 —— 因为要用 FTS5 的 `contentless_delete`（上述 Node 版本已自带）

缺任一条件时，扩展会拒绝启动并给出可执行的提示，而不是抛一个看不懂的 SQLite 错误。

## 安装

```bash
pi install npm:pi-memory-sessions
```

或直接从仓库装：

```bash
pi install github:877007021/pi-memory-sessions
```

或用单次调用的方式试一下（不写进配置）：

```bash
pi -e npm:pi-memory-sessions
```

> ⚠️ **不要同时用两种方式安装。** 如果 `~/.pi/agent/extensions/pi-memory-sessions/` 里有一份手动复制的副本，`pi install npm:` 之后两份会同时加载，导致
> `Tool "session_search" conflicts with ...`。二选一。

## 用法

模型侧工具（已声明 `promptSnippet` + `promptGuidelines`，所以会出现在 system prompt 里，不用提示就会自己用）：

| 工具 | 作用 |
|---|---|
| `session_search` | 按关键词搜历史会话 |
| `session_read` | 读命中点前后的连续对话 |

你自己用的命令：

```bash
/recall <关键词>   搜索
/recall stats      库体积、消息数、会话数
/recall import     导入已有的 sessions/*.jsonl（分批写入，不卡界面）
```

> `/recall import` 是用来补插件安装之前的历史。可以反复执行 —— 写入是幂等的。

## 它怎么工作

```
message_end      ─┐
session_start     │
session_compact   ├─→ 渲染 markdown ─→ SQLite (WAL) ─→ 双通道 FTS5
session_shutdown ─┘                                        ↑
                                          session_search / session_read / /recall
```

捕获发生在 `message_end` —— pi 在这个时机对**每一条**已定稿的消息触发，且在写盘之前。**成功的工具输出刻意丢弃**：它占原始记录约 90% 的体积，信息密度却是最低的。

`session_search` 是三阶段流水线：

1. **分词** —— 中文单字用于召回，中文双字用于精度，拉丁词两路都进。
2. **召回** —— 取最稀有的三个单字作锚点，执行 `FTS5 chars:("a" "b" "c") ORDER BY rowid DESC LIMIT K`，让 FTS5 能提前终止。
3. **打分** —— 按双字覆盖率排序，时间做 tiebreak。

每一阶段的存在，都是因为朴素的替代方案被实测否掉了：

| 朴素做法 | 实测失败方式 |
|---|---|
| 所有双字做 AND | 5 字以上的中文自然语言查询 **0 命中** |
| 所有双字做 OR | 候选窗口被高频字挤爆 |
| IDF 加权 | 跨词双字（`的缓`、`式是`）稀有但无意义，会抢走权重 |
| `ORDER BY bm25` | 必须给所有命中打分：36 ms，且随库线性增长 |
| `LIKE '%x%'` | 全表扫描：87 ms，且随库线性增长 |

**查询耗时是 O(候选窗口)，不是 O(库大小)。**

## 性能

29.5k 条真实消息 / 95 MB 索引上的实测：

| 操作 | 耗时 |
|---|---|
| 写入一条消息 | 0.53 ms |
| 检索（K=200 候选） | 5–15 ms |
| 读 21 条上下文 | 0.06 ms |
| 第二个 pi 进程并发写入 | 1.2 ms |

真实安装环境（7,370 条消息 / 41 个会话）：检索 p50 **0.1–0.4 ms**。

## 安全

**本扩展原样保存会话记录，不做任何脱敏。**

这是有意的选择：打码会破坏可搜索性（想搜 `OPENAI_API_KEY` 或某个 token 变量名就搜不到了），而部分打码比完全不脱敏**更危险** —— 它会让人误以为库里是干净的，其实不是。

你必须接受的后果：

- `~/.pi/memory/sessions.db` 里包含**你和你的工具打印过的一切**，包括流经对话的密钥。
- 请把它当敏感文件：不要提交、不要同步到公开位置、备份要加密。
- pi 自己的 `sessions/*.jsonl` 本来就存着同样的内容，这个索引不比 pi 已有的更宽 —— 但它集中在一个文件里，而且活得比 `sessions/` 的删除更久。

如果想把库放到加密卷上，用 `PI_MEMORY_DB` 改路径。

## 数据

```
~/.pi/memory/sessions.db
```

| 存 | 不存 |
|---|---|
| user 消息 | system prompt |
| assistant 正文 | thinking 块 |
| 工具调用（名称 + 参数） | 成功的工具输出 |
| 失败的工具输出（前 500 字） | 图片二进制 |
| compaction 摘要 | |

**为什么 compaction 摘要值得单独存：** 上下文窗口满时，pi 会把旧内容压成一段结构化摘要（Goal / Decisions / Next Steps）。在一个真实库里，28 条摘要平均 14,746 字符 —— 一条摘要承载的信息量大约相当于 40 条普通消息，而且它已经是"pi 当时认为什么重要"的提炼版本。

## 路径与环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PI_MEMORY_DB` | `~/.pi/memory/sessions.db` | 索引库位置 |
| `PI_MEMORY_SESSIONS_DIR` | 跟随 pi | `/recall import` 从这里读 `*.jsonl` |
| `PI_CODING_AGENT_SESSION_DIR` | — | pi 自己的会话目录，自动跟随 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 的配置目录，会话读 `<dir>/sessions` |

**容器 / `$HOME` 不持久的场景。** 两个默认值都在 `$HOME` 下。如果 `$HOME` 是容器层（每次部署重建），索引会跟着一起丢；而 pi 把会话放到别处时，这里根本扫不到 —— 症状是 `/recall import` 报 `0 个文件`，但不报错。显式给路径：

```bash
PI_MEMORY_DB=/data/agent/pi-memory/sessions.db
PI_MEMORY_SESSIONS_DIR=/data/agent/sessions
```

`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` 也会被读取，所以已经配置过自定义布局的 pi 不用再额外设置。

## 已知局限

1. **不做繁简归一** —— 繁体查询搜不到简体内容。
2. **没有词典分词** —— 精确短语能力弱于真正的分词器；靠稀有字锚点 + 双字打分弥补。
3. **安装之前的会话不会被捕获** —— 用 `/recall import` 补，并确认它报的文件数不是 0（见 [路径与环境变量](#路径与环境变量)）。
4. **写入失败不会重试** —— 真相源仍然是 pi 的会话文件，重跑 `/recall import` 即可。写入失败不会影响当轮对话。
5. **没有向量检索** —— 见下。
6. **还没有 `forget`** —— 删数据得手动用 `sqlite3`。

### 为什么不用向量检索

两个务实的理由：依赖数保持为零，查询保持在个位数毫秒。语义检索在"记得概念但忘了用词"时确实有用 —— 这是一个真实的缺口，也是下一步要加的东西（新增一张以 `msg.id` 为键的 `vec` 表，不改动现有表结构）。

## 开发

```bash
node --test test/unit.test.ts      # 47 个测试，不需要 pi、不需要模型、不需要安装依赖
node --no-warnings bench/smoke.ts  # 用 mock ExtensionAPI 加载 index.ts
node --no-warnings bench/replay.ts # 回放真实的 ~/.pi/agent/sessions 并输出延迟
node --no-warnings bench/capabilities.ts # 检查 node:sqlite / FTS5 / contentless_delete / WAL
```

设计笔记、实测数据，以及被测试推翻的那些假设，都在 [DESIGN.md](DESIGN.md)（中文）。

### 发版

发布走 npm Trusted Publishing（OIDC），所以仓库里没有 npm token，也不需要 OTP。

```bash
npm version patch        # 或 minor / major
git push --follow-tags
```

`v*` tag 会触发 `.github/workflows/publish.yml`：校验 tag 与 `package.json` 版本一致 → 跑测试和能力检测 → 带 provenance 签名发布。

npm 上必须已经存在这个包，Trusted Publishing 才能配置 —— 所以首个版本仍需用 token 或 OTP 手动发一次。

## License

MIT

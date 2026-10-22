# pi-memory 设计方案

**状态**：v1 已实现（见 §15 实现说明与偏差）
**日期**：2026-10-22
**目标**：把 pi 的会话持久化到自己拥有的存储里，支持中文/英文/中英混合的关键词检索，供人和模型按需读取。

---

## 0. 一句话

`message_end` 事件逐条捕获消息 → 渲染成 markdown 落进 SQLite（WAL）→ 双通道 n-gram 索引 → 三阶段检索（最稀有字锚点召回 + bigram 覆盖率打分）→ 两个工具 + 一个命令暴露。

---

## 1. 目标与非目标

### 目标

1. 会话内容**不依赖** `~/.pi/agent/sessions/*.jsonl` 存活（那个文件会被删）
2. 中文、英文、中英混排都能按关键词搜到
3. 检索耗时是**常数级**（不随库增长退化），任何单次查询 < 50ms
4. 写入发生在 turn 边界，单条 < 1ms，不影响对话体感
5. 多 pi 进程同时运行不互相锁死
6. 模型能直接读懂检索结果；人能用 `/recall` 自己查

### 非目标（v1 明确不做）

- 语义/向量检索
- 自动抽取"用户偏好"并注入 system prompt
- 跨工具共享（Claude Code / Codex）
- Web UI
- 繁简转换归一化
- 会话级聚合排序（v1.1）
- 自动清理/压缩

---

## 2. 已验证的环境事实

全部在真实机器 + 真实语料上实测，不是假设。

| 事实 | 结论 |
|---|---|
| Node `>=22.19`（pi 的 engines） | `node:sqlite` 可用，**零依赖** |
| FTS5 | 可用 |
| `contentless_delete=1` | 可用（SQLite 3.43+，Node 22.22 自带版本 OK） |
| 中文直接喂 FTS5 | 不可用：`unicode61` 把整句中文当一个 token；`trigram` 要求查询 ≥3 字 |
| 预分词成空格分隔 token | 可用 |
| `ORDER BY bm25` | 可算但**随库线性增长**，不用 |
| `ORDER BY msg_fts.rowid DESC` | FTS5 早停，0.1ms |
| 繁简混排 | 古籍是繁体，`宝玉` 查不到 `寶玉`。真实 pi 会话是简体，不处理 |

### 基准语料

下载的真实语料，非合成：

| 来源 | 文件 | 字符 |
|---|---|---|
| 中文古籍（Gutenberg，繁体） | 26 本 | 6.6M |
| 英文小说（Gutenberg） | 12 本 | 10.2M |
| 中英混排技术文档（GitHub `vuejs-translations/docs-zh-cn`） | 221 个 md/json/ts/vue | 0.9M |
| **合计** | 259 | **17.8M 字符 → 29,554 条消息（平均 625 字）** |

---

## 3. 架构

```
┌─ pi 进程 ────────────────────────────────────────────┐
│                                                      │
│  message_end ──┐                                     │
│  session_start ┼──→ capture ──→ render ──→ redact    │
│  session_compact┤        │                           │
│  session_shutdown┘       ↓                           │
│                    SQLite (WAL)                      │
│                    ~/.pi/memory/sessions.db          │
│                          ↑                           │
│  session_search ─────────┤                           │
│  session_read  ──────────┤                           │
│  /recall       ──────────┘                           │
└──────────────────────────────────────────────────────┘
```

DB 是**派生物**，不是唯一真相：pi 的 jsonl 仍然在，写失败可以重新导入。但正常路径上永不读取 jsonl。

---

## 4. 存储

### 4.1 位置

```
~/.pi/memory/
  sessions.db          # 主库
  sessions.db-wal      # WAL
  config.json          # 可选配置
```

全局单库（所有项目），因为记忆的价值一半在"跨项目想起"。项目只在检索时作为过滤/加权维度。

### 4.2 Schema

```sql
pragma journal_mode = WAL;
pragma synchronous  = NORMAL;
pragma busy_timeout = 5000;
pragma user_version = 1;          -- schema 版本，用于迁移

create table session (
  id         text primary key,    -- pi session id
  cwd        text not null,
  project    text not null,       -- cwd 归一化（basename 或最后两级）
  started_at integer not null,    -- unix ms
  last_at    integer not null,
  name       text                 -- session_info_changed 提供的名字
);

create table msg (
  id         integer primary key, -- 同时是 FTS 的 rowid，插入序 = 时间序
  session_id text    not null,
  seq        integer not null,    -- 会话内单调序号，展示顺序的唯一依据
  ts         integer not null,    -- unix ms
  role       text    not null,    -- user | assistant | tool_error | summary
  text       text    not null,    -- 渲染后的 markdown，可直接读
  chars      integer not null,
  meta       text,                -- json: {model, tool, isError, truncated, tokens}
  hash       text    not null,
  unique(session_id, hash)
);

create index msg_session_seq on msg(session_id, seq);

-- 双通道索引：chars = 单字/单词，grams = 中文双字/单词
create virtual table msg_fts using fts5(
  chars,
  grams,
  content='',
  contentless_delete=1
);
```

### 4.3 刻意的设计决定

| 决定 | 理由 |
|---|---|
| `content=''` contentless | FTS 只存倒排索引，不存原文副本，省一半空间 |
| 不用 `snippet()` | contentless 无原文可截；且我们的 token 本身就是原文子串，自己截更准 |
| 不建 `ts` 索引 | 实测 `ORDER BY ts` 无法早停（182ms），排序一律用 rowid |
| `seq` 不用时间戳推导 | 并行 toolResult 会同毫秒；`seq` 才是可靠序号 |
| 无 `term_df` 表 | 见 §7.4：进程内 LRU 够了，不值得为它加写入成本 |
| 保留 `hash` 唯一约束 | 幂等写入的唯一手段，代价 0.04ms/条 |

### 4.4 体积（实测）

| 配置 | 29,554 条消息 | 折算 |
|---|---|---|
| 仅 bigram | 77 MB | 0.35 ms/条写入 |
| uni + bi 双通道 | 95 MB | 0.53 ms/条写入 |

双通道多 23% 体积，换来长查询可召回。**接受**。

预估真实用户：一个 266KB 的 session → 20–40KB 入库；50MB 的会话历史 → ~130MB 库。

---

## 5. 写入路径

### 5.1 事件挂钩

| 事件 | 动作 |
|---|---|
| `message_end` | 逐条捕获（**唯一完整的捕获点**） |
| `session_start` | 登记 session（id/cwd/project/时间/name）；`reason` 决定是否回灌 |
| `session_compact` | 捕获 `summary` 条目（`role='summary'`） |
| `session_shutdown` | 关闭连接（幂等） |

**为什么必须是 `message_end`**：源码确认它对 `custom / system / user / assistant / toolResult` 每一类都触发，且在落盘之前。`turn_end` 只给该 turn 最后一个 assistant 消息，多工具调用之间的 assistant 消息会漏。

### 5.2 消息渲染规则

`msg.text` 是渲染后的 markdown —— **不是原始 JSON**。这部分直接决定"AI 读取消息"时能不能读懂。

| 输入 | role | text |
|---|---|---|
| user 文本 | `user` | 原文；图片记 `[图片]` |
| assistant text 块 | `assistant` | 拼接；**不含 thinking** |
| assistant toolCall | `assistant` | `→ read({"path":"src/a.ts"})`，参数 JSON 截断 300 字 |
| toolResult 成功 | — | **丢弃** |
| toolResult 失败 | `tool_error` | `✗ bash: <前 500 字>` |
| compaction | `summary` | 摘要全文 |

丢弃成功的 toolResult：它占原始体积 90% 且信息密度最低。实测这样入库体积是原始 jsonl 的 10–20%。

### 5.3 幂等主键

```js
hash = sha1(session_id + ":" + role + ":" + message.timestamp + ":" + sha1(text)).slice(0,16)
```

配 `INSERT OR IGNORE` + `unique(session_id, hash)`：

- `message_end` 不给 entry id，必须自造
- 扩展 reload、自动重试、重复 emit → 全部吸收
- resume 不重放旧消息 → 不会重复写

### 5.4 `seq` 分配

内存计数器，每个 session 首次写入时用一次 `select coalesce(max(seq),0)` 初始化，之后自增。**不是每条消息查一次。**

### 5.5 写入事务

```js
// 每条消息一次自动提交，绝不攒批
db.exec("begin immediate")
insert msg; insert fts; update session.last_at
db.exec("commit")
```

放弃攒批的理由：攒批 = 持锁更久 + 崩溃丢一批，两头都亏。单条 0.53ms 没有必要优化。

### 5.6 脱敏

**不做。**（2026-10-22 由需求方明确要求）

理由：这是本地私有库，内容只进自己的磁盘；打码会破坏可搜索性（想搜 `OPENAI_API_KEY` 或某个 token 变量名会搜不到），而且部分打码比不打码更危险 —— 会让人误以为库里没有密钥。

代价必须写清楚：**`~/.pi/memory/sessions.db` 里会有贴过的全部内容，包括密钥。** 这个文件应当按敏感数据处理：不要提交、不要同步到公开位置、备份要加密。

### 5.7 失败处理

```
try { write } catch (e) {
  if (第一次失败) ctx.ui.notify("记忆写入失败，将在下次会话导入补齐")
  // 不抛出、不阻塞 turn
}
```

原则：**记忆是附属品，不能变成单点故障**。数据不会真丢 —— jsonl 还在，可重新导入。

---

## 6. 分词

```js
function tokenize(s) {
  s = s.toLowerCase();
  for (run of s.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]+/g)) {
    if (latin) { chars.push(run); grams.push(run); }
    else {
      for (ch of run) chars.push(ch);              // 单字 → 召回通道
      for (i of 0..run.length-2) grams.push(run[i..i+2]);  // 双字 → 精度通道
    }
  }
}
```

- 拉丁 token **同时进两个通道**（`whale`、`reactive` 既能当锚点也能当打分）
- CJK 单字只进 `chars`，双字只进 `grams`
- 长度 1 的 CJK run 只进 `chars`
- 不做停用词表：越常见的词 df 越高、越不会被选成锚点，**统计自动完成过滤**

---

## 7. 检索

### 7.1 三阶段流水线

```
query
 ├─ ① tokenize → chars[] grams[]
 ├─ ② 按 df 升序取最稀有 3 个 token 作锚点（df=0 的丢弃）
 ├─ ③ FTS5:  chars:("锚1" "锚2" "锚3")
 │          ORDER BY rowid DESC LIMIT K=200          ← 早停，O(K)
 ├─ ③' 若命中 0：锚点改 OR 重试一次
 └─ ④ 打分：grams 在 text 中的覆盖率；tiebreak 用 ts 降序
      取 top-N
```

### 7.2 为什么每一步都必须存在（每条都有实测）

| 步骤 | 不这么做的后果 | 证据 |
|---|---|---|
| 锚点召回（而非 AND 全部） | ≥5 字中文查询 **全部 0 命中** | `我一直搞不清楚响应式是怎么实现的`：bigram AND=0, unigram AND=0 |
| 锚点用**单字**而非双字 | 跨词双字（`的缓`/`式是`）稀有但无意义，会抢走权重，命中无关内容 | IDF 加权版：`缓存索引优化方案` 的最高权重是 `的缓`、`化方` |
| 锚点选**最稀有**的 | OR 会被高频字挤爆候选窗口，正确结果进不来 | 长查询 OR 覆盖率分布 199/1/0/0/0 |
| 打分用 **bigram** 覆盖率 | 单字不区分连续性，`缓存` 和 `存缓` 同分 | 短查询 score=1.00，长查询降级到 0.27–0.57 |
| 排序用 **rowid** 而非 bm25 | bm25 必须给所有命中打分，随库线性增长 | 36ms（df=18.5%）vs 0.1ms；合成语料 325ms |

### 7.3 效果（实测）

| 查询 | 命中 | 耗时 | top1 |
|---|---|---|---|
| `我一直搞不清楚响应式是怎么实现的` | 5 | 11.6ms | 相关 |
| `之前那个组件的响应式实现有问题` | 5 | 1.5ms | 相关 |
| `上次讨论过的缓存索引优化方案` | 1 | 1.0ms | 相关 |
| `组件响应式原理` | 5 | 4.2ms | 相关 |
| `响应式` | 5 | 3.1ms | 相关 score=1.00 |
| `锁`（单字） | 4 | 0.5ms | — |
| `the whale and the sea` | 5 | 2.6ms | Moby Dick 原文 |
| `how does the reactive system work` | 5 | 10.2ms | 相关 |

9/9 查询的 top1 命中预期。长查询从「0 命中」变为「1–5 命中，≤15ms」。

### 7.4 df 从哪来

`select count(*) from msg_fts where msg_fts match 'chars:("字")'`，实测 0.3–0.7ms。

**不建 `term_df` 表**，用进程内 LRU：

- key = token，value = {df, 计算时的 msg_count}
- 当 `msg_count` 增长超过 2% 时整表失效
- 冷启动长查询最坏 = 16 token × 0.5ms = 8ms 额外开销
- 同词重复查询命中缓存后为 0

加表的代价：每条约 1200 次 upsert（单字+双字），写入从 0.53ms 涨到 5ms+，**不划算**。

### 7.5 复杂度的保证

| 操作 | 复杂度 | 实测 @ 29.5k 消息 |
|---|---|---|
| 写入 | O(1) | 0.53 ms |
| 取候选 K=200 | O(K) | 3.3 ms |
| 完整 search（K=200） | O(K × 平均 token 数) | 5 ms |
| 窗口读 21 条 | O(21 log n) | 0.06 ms |
| 全表 LIKE | O(n) ❌ **禁用** | 87 ms 且增长 |

**结论：库里有多少数据，不影响单次查询耗时。** 唯一随时间增长的是 df 缓存失效后的重算。

---

## 8. 接口

### 8.1 `session_search`（模型用）

```
query:   string   必填。关键词或短句。
limit?:  number   默认 10，上限 20
project?: string  只搜某个项目
since?:  string   ISO 日期，只搜之后的
```

输出（每条）：

```
[2026-10-15 · ~/code/foo · 会话名] msg_id=12345 session=01a1632f
  ...命中前文…【缓存】索引…命中后文…
```

- 片段 ±150 字，围绕第一个命中的 gram
- 按 session 分组展示，最多 5 个 session
- **总输出硬上限 6K 字符**

description 必须写明：*用户说「上次」「之前」「以前那个」时，先用这个工具搜。传关键词，不要传整句。*

### 8.2 `session_read`（模型用）

```
session_id:     string  必填
around_msg_id?: number  从哪条展开（默认取该 session 最后一条）
before?:        number  默认 4
after?:         number  默认 6
```

输出：

```
# 2026-10-15 14:02 · ~/code/foo · 会话 "修复 SSE 断流"
[120] user: ...
[121] assistant: ...
[122] tool_error: ✗ bash: ...
```

- 单条 > 1500 字截断并标注
- **总输出硬上限 8K 字符**

### 8.3 `/recall`（人用）

```
/recall <关键词>        交互式结果列表，回车跳到对应会话
/recall import          一次性导入现有 jsonl（分批 + 让出事件循环）
/recall stats           库大小、消息数、会话数、最老/最新
```

`/recall` 是人类日常真正会用的入口 —— 不依赖模型判断要不要搜。

---

## 9. 并发与锁

### 9.1 规则

1. `journal_mode=WAL` + `busy_timeout=5000`：读永不阻塞写
2. 写入**不攒批**，单条自动提交，持锁 ≈1ms
3. **绝不在事务里做 IO / LLM 调用**，锁只包纯 SQL
4. 导入分批：每 200 条一个事务（8.2ms），批间 `await new Promise(r => setImmediate(r))`
5. 每进程一个连接，模块级单例，`session_shutdown` 关闭

### 9.2 实测

| 场景 | 耗时 |
|---|---|
| 第二连接并发写入（含 WAL 提交） | 1.2 – 3 ms |
| 200 条批量事务 | 8.2 ms |
| 29.5k 条全量重建 | 10.4 s（分 148 批） |

### 9.3 唯一真实的锁风险

`node:sqlite` 是**同步 API**。一次性导 20 万条会把 pi 的事件循环卡住十几秒（UI 无响应）并长期持锁。所以规则 4 不是优化，是**正确性要求**。

---

## 10. 错误处理与降级

| 故障 | 处理 |
|---|---|
| 写入失败 / SQLITE_BUSY 超时 | try/catch 吞掉 + 每 session 提示一次；jsonl 仍可重新导入 |
| DB 损坏 | `pragma integrity_check` 失败 → 重命名为 `.corrupt` 后重建 + 提示导入 |
| `node:sqlite` 不可用（Node < 22.5） | 启动时检测，禁用扩展并明确提示，**不做降级实现** |
| df 查询慢 | LRU 兜底；不阻塞，最坏退化到按字面顺序取候选 |
| 查询结果为空 | 返回「无命中」，不自动放宽到全表扫 |

---

## 11. 已知局限（写进 README，不藏）

1. **繁简不归一**：繁体查询搜不到简体内容，反之亦然。真实 pi 会话是简体，v1 接受。
2. **词边界不存在**：双字切分无词典。锚点策略绕开了噪音，但"精确短语"能力弱于真分词器。
3. **单字查询走前缀/锚点**，不做全表 LIKE。极端情况下会漏字符在词尾的匹配。
4. **会话级聚合缺失**（v1.1）：现在返回消息级 top-N。真实记忆场景更想要"哪个会话讲过这事"。
5. **插件未加载期间的会话不捕获**：只能靠 `/recall import` 事后补。
6. **流式中途崩溃的消息丢失**：`message_end` 未触发。
7. **DB 本身可被删除**：建议纳入个人备份；提供 `/recall stats` 让体积可见。

---

## 12. 里程碑

### v1（本设计）

- `message_end` 捕获 + 渲染 + 幂等写入（不做脱敏）
- 双通道 FTS5 索引
- 三阶段检索 + df LRU
- `session_search` / `session_read` / `/recall`
- `/recall import`（分批）
- 基准脚本入库（`bench/`），可复跑验证

### v1.1

- 会话级聚合排序（结果按"哪个会话"排）
- `/recall forget <session|msg>`（真删，走 `contentless_delete`）
- 结果里带"会话首条 user 消息"作为摘要

### v2

- 向量检索（新增 `vec` 表，以 `msg.id` 为键，不改现有 schema）
- 词典分词（jieba/nodesh）作为可选插件
- 繁简归一化

---

## 13. 待定

| # | 决策 | 建议 |
|---|---|---|
| 1 | 首次启动是否自动问"要导入历史吗" | **不自动**，纯手动 `/recall import`（少一条交互分支） |
| 2 | `session_start(reason=reload)` 是否用 `getEntries()` 回灌当前会话 | **要**，`INSERT OR IGNORE` 天然去重，代价近零 |
| 3 | 候选窗口 K 默认值 | **200**（3.3ms）；工具允许参数覆盖到 1000 |
| 4 | 是否记录 toolResult 成功内容 | **不记**；只记 `isError` 的前 500 字 |

---

## 14. 验证方式

实现已落地，全部可复跑：

| 命令 | 覆盖 | 结果 |
|---|---|---|
| `node --test test/unit.test.ts` | 分词 / 渲染 / 存储 / 检索 / 格式化 | 43 通过 |
| `node --no-warnings bench/smoke.ts` | 接线：mock ExtensionAPI → 事件 → 工具 → 命令 | 18 通过 |
| `node --no-warnings bench/replay.ts` | 真实 `sessions/*.jsonl` 回放 + 延迟分布 | 见下 |

真实回放结果（本机 38 个会话）：

```
导入 38 文件 / 7290 条 / 3184ms / 库 14.7MB
重复导入新增 0 条（幂等）
查询 "缓存" 8.2ms / "索引" 9.1ms
```

---

## 15. 实现说明与偏差

实现过程中对文档做了以下修正，都是被测试或实测数据推着改的：

| 项 | 文档原文 | 实现 | 原因 |
|---|---|---|---|
| 列名 | `msg.chars` | `msg.nchars` | FTS 列也叫 `chars`，`chars:(...)` 列过滤在 join 下会和普通列混淆 |
| 回灌来源 | `getEntries()` | `getBranch()` | 只回灌活跃分支，避免把废弃分支也写进库 |
| 回灌时机 | 仅 `reload` | `reload` + `resume` | resume 时历史不会重放，不补就永久缺失；幂等键保证安全 |
| 分词正则 | `[\u4e00-\u9fff]` | 加 CJK 扩展 A/B + `u` 标志 | 扩展区在 BMP 之外，否则代理对被整段丢弃 |
| 单条上限 | 未定 | 20000 字符 | 防止超大工具输出把库撑爆 |

新增的、文档里没写的实现细节：

- **`seq` 冲突保护**：重复 hash 被 `INSERT OR IGNORE` 吞掉时不消费 `seq`，并让序号缓存失效，避免下一条消息复用一个已存在的序号。
- **`df` 缓存的失效条件**用「库行数漂移 >2%」，不是时间。库在长会话里持续增长，时间失效会让锚点选错。
- **`session_read` 窗口默认前后不对称**（前 4 后 6）：命中点之前是意图，之后是结果，结果通常更长。
- **失败 toolResult 截断到 500 字**，成功的一条不存：实测这部分占原始体积约 90%。

仍然没有做的（与 §11 一致）：会话级聚合排序、`forget`、繁简归一、向量检索、typecheck（本机未装 `typescript`，运行时走 jiti 不做类型检查）。

---

## 附录 A：关键实测数据汇总

| 指标 | 值 | 条件 |
|---|---|---|
| 单条写入 | 0.35 ms | bigram 单通道 |
| 单条写入 | 0.53 ms | uni+bi 双通道 |
| 200 条批量事务 | 8.2 ms | 含唯一键检查 |
| 取候选 K=200 | 3.3 ms | 单 JOIN 带回正文 |
| 取候选 K=500 | 10.7 ms | |
| 取候选 K=2000 | 40.0 ms | |
| 完整 search K=200 | 5 ms | 含重排 |
| `ORDER BY bm25` | 36 ms | df=18.5% 的高频词 |
| `ORDER BY rowid DESC` | 0.1 ms | 同上 |
| 窗口读 21 条 | 0.06 ms | 走 `msg_session_seq` |
| 全表 LIKE | 87 ms | **禁用** |
| 前缀匹配（单字） | 15 ms / 9137 命中 | 召回覆盖 97% |
| 深分页 offset=5000 | 24 ms | 用 keyset 替代 |
| 并发第二连接写入 | 1.2–3 ms | WAL |
| 库体积 | 95 MB / 29.5k 消息 | uni+bi |

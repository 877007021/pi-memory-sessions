# pi-memory-sessions

Keyword recall over **your past [pi](https://github.com/earendil-works/pi) sessions** — works for Chinese, English, and mixed content.

Every conversation pi runs is captured into a SQLite index that this extension owns. Delete pi's `sessions/*.jsonl` and recall still works. Ask "what did we decide about X last month?" and the agent can actually answer, because it can search.

Zero runtime dependencies: `node:sqlite` + FTS5, both built into Node.

```text
you ▸ /recall 缓存索引
      命中 8 条（2.4ms）
      [2026-10-15 14:02 · 3 周前 · ~/code/api · "cache sharding"]
        #122 assistant msg_id=5541 score=1.00
          …按会话分片，索引写在 WAL 之后…【缓存】索引…
```

## What this is / is not

| | |
|---|---|
| **Is** | Automatic, lossless capture of session transcripts, searchable by keyword |
| **Is not** | A note-taking memory (`MEMORY.md`). Nothing is curated, summarized, or injected into the system prompt |
| **Is not** | Semantic/vector search. Keywords only ([why](#why-keywords-and-not-vectors)) |

If you want the agent to *remember a preference*, that is a curated-notes problem. This solves the other half: *finding what actually happened*.

## Requirements

- pi ≥ 1.0
- **Node ≥ 22.19** — for `node:sqlite`
- SQLite ≥ 3.43 — for FTS5 `contentless_delete` (bundled with the Node versions above)

The extension refuses to start with an actionable message if either is missing.

## Install

```bash
pi install npm:pi-memory-sessions
```

Or straight from the repository:

```bash
pi install github:877007021/pi-memory-sessions
```

Or load a checkout directly:

```bash
pi --extension ./index.ts
```

Or copy the directory into `~/.pi/agent/extensions/` (auto-discovered, no settings change).

## Usage

Model-facing tools (registered with `promptSnippet` + `promptGuidelines`, so they appear in the system prompt and get used without being told):

| Tool | Purpose |
|---|---|
| `session_search` | Search past sessions by keyword |
| `session_read` | Read a contiguous window around a hit |

User-facing command:

```bash
/recall <keyword>   search
/recall stats       store size, message and session counts
/recall import      import existing sessions/*.jsonl (batched, does not block the UI)
```

> `/recall import` is how you get history from before the extension was installed. It is safe to run repeatedly — writes are idempotent.

## How it works

```
message_end      ─┐
session_start     │
session_compact   ├─→ render markdown ─→ SQLite (WAL) ─→ dual-channel FTS5
session_shutdown ─┘                                            ↑
                                          session_search / session_read / /recall
```

Capture happens at `message_end`, which fires for every finalized message before pi persists it. Successful tool results are dropped: they are ~90% of transcript volume and the lowest-signal content in it.

`session_search` is a three-stage pipeline:

1. **Tokenize** — CJK unigrams for recall, CJK bigrams for precision, Latin tokens in both channels.
2. **Recall** — take the three rarest unigrams as anchors, then `FTS5 chars:("a" "b" "c") ORDER BY rowid DESC LIMIT K`, which lets FTS5 stop early.
3. **Score** — bigram coverage, with recency as the tiebreak.

Each stage exists because the naive alternative was measured and failed:

| Naive approach | Measured failure |
|---|---|
| AND over all bigrams | **0 hits** for any natural-language Chinese query of 5+ chars |
| OR over all bigrams | candidates swamped by high-frequency characters |
| IDF weighting | cross-word bigrams (`的缓`, `式是`) are rare but meaningless, so they win the ranking |
| `ORDER BY bm25` | must score every match: 36 ms and grows linearly |
| `LIKE '%x%'` | full scan, 87 ms and grows linearly |

Query cost is **O(candidate window)**, not O(store size).

## Performance

Measured on 29.5k real messages / 95 MB index:

| Operation | Time |
|---|---|
| Write one message | 0.53 ms |
| Search (K=200 candidates) | 5–15 ms |
| Read 21 messages of context | 0.06 ms |
| Second pi process writing concurrently | 1.2 ms |

Real install, 7,370 messages / 41 sessions: search p50 **0.1–0.4 ms**.

## Security

**This extension stores transcripts verbatim. There is no redaction.**

That is a deliberate choice: masking breaks searchability (you cannot search for `OPENAI_API_KEY` or a variable name if it was replaced), and partial masking is worse than none because it implies the store is clean when it is not.

Consequences you must accept:

- `~/.pi/memory/sessions.db` contains **everything you or your tools ever printed**, including secrets that passed through a conversation.
- Treat it as a sensitive file: do not commit it, do not sync it to a public location, encrypt backups.
- pi's own `sessions/*.jsonl` already stores the same content; this index is no broader than what pi already keeps, but it is in one file and it outlives `sessions/` deletion.

`PI_MEMORY_DB` relocates the store if you want it on an encrypted volume.

## Data

```
~/.pi/memory/sessions.db
```

| Stored | Dropped |
|---|---|
| user messages | system prompt |
| assistant text | thinking blocks |
| tool calls (name + arguments) | successful tool results |
| failed tool results (first 500 chars) | image payloads |
| compaction summaries | |

**Why compaction summaries matter:** pi compresses old context into a structured summary (Goal / Decisions / Next Steps) when the window fills. In a real store, 28 summaries averaged 14,746 chars — a single summary carries roughly 40 messages' worth of signal, and it is already the distilled version of what pi judged important.

## Known limitations

1. **No traditional↔simplified normalization** — a traditional query will not match simplified content.
2. **No dictionary segmentation** — exact-phrase matching is weaker than a real tokenizer; rare-character anchors plus bigram scoring compensate.
3. **Sessions before install are not captured** — use `/recall import`.
4. **A dropped write is not retried** — the source of truth is still pi's session file, so re-run `/recall import`. A write failure never breaks a turn.
5. **No vector search** — see below.
6. **No `forget` yet** — deleting rows requires `sqlite3` by hand.

### Why keywords and not vectors

Two reasons, both practical: it keeps the dependency count at zero and the query at single-digit milliseconds. Semantic search would help when you remember the concept but not the words — that is a real gap, and it is the next thing to add (a `vec` table keyed by `msg.id`, no schema change to existing tables).

## Development

```bash
node --test test/unit.test.ts      # 43 tests, no pi, no model, no installs
node --no-warnings bench/smoke.ts  # loads index.ts against a mock ExtensionAPI
node --no-warnings bench/replay.ts # replays real ~/.pi/agent/sessions and reports latency
```

Design notes, measurements, and the assumptions that testing disproved are in [DESIGN.md](DESIGN.md).

## License

MIT

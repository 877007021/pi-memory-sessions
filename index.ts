/**
 * pi-memory — 会话长期记忆（关键词检索）
 *
 * 捕获 message_end → 渲染 markdown → SQLite(WAL) → 双通道 FTS5
 * → session_search / session_read / /recall
 *
 * 设计见 DESIGN.md。核心约束：
 *   - 库是派生物，写入失败不影响对话
 *   - 查询复杂度 O(K)，与库大小无关
 *   - 单条写入 < 1ms，不攒批，持锁 ~1ms
 */

import type { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SCHEMA_VERSION,
	getSession,
	insertMessage,
	maxSeq,
	messageHash,
	openDb,
	projectOf,
	stats,
	touchSession,
	upsertSession,
} from "./src/db.ts";
import { SEARCH_MAX_CHARS, READ_MAX_CHARS, formatSearch, formatSessionRead } from "./src/format.ts";
import { importSessions } from "./src/import.ts";
import { dbFile, sessionsRoot } from "./src/paths.ts";
import { renderMessage, renderSummary } from "./src/render.ts";
import { createSearcher } from "./src/search.ts";

type State = {
	db: DatabaseSync | null;
	searcher: ReturnType<typeof createSearcher> | null;
	counters: Map<string, number>;
	openError: string | null;
	warned: boolean;
};

const state: State = { db: null, searcher: null, counters: new Map(), openError: null, warned: false };

function ensureDb(): DatabaseSync {
	if (state.db) return state.db;
	state.db = openDb(dbFile());
	state.searcher = createSearcher(state.db);
	return state.db;
}

function warnOnce(ctx: ExtensionContext | undefined, message: string): void {
	if (state.warned) return;
	state.warned = true;
	try {
		ctx?.ui?.notify(message, "warning");
	} catch {
		// 无 UI 模式（json/print）忽略
	}
}

function sessionIdOf(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function nextSeq(db: DatabaseSync, sessionId: string): number {
	const cached = state.counters.get(sessionId);
	if (cached != null) return cached;
	const seq = maxSeq(db, sessionId);
	state.counters.set(sessionId, seq);
	return seq;
}

/**
 * 幂等写入。重复的 hash 不消费 seq，并让计数器失效，
 * 避免下一条消息复用一个已存在的序号。
 */
function writeMessage(
	sessionId: string,
	rendered: { role: any; text: string; meta?: Record<string, unknown> },
	ts: number,
): boolean {
	const db = ensureDb();
	const seq = nextSeq(db, sessionId) + 1;
	const hash = messageHash(sessionId, rendered.role, ts, rendered.text);

	db.exec("begin immediate");
	try {
		const inserted = insertMessage(db, {
			sessionId,
			seq,
			ts,
			role: rendered.role,
			text: rendered.text,
			hash,
			meta: rendered.meta,
		});
		if (inserted) {
			state.counters.set(sessionId, seq);
			touchSession(db, sessionId, ts);
		} else {
			state.counters.delete(sessionId);
		}
		db.exec("commit");
		return inserted;
	} catch (error) {
		try {
			db.exec("rollback");
		} catch {
			// 未开启或已回滚
		}
		throw error;
	}
}

function registerSession(ctx: ExtensionContext): void {
	const db = ensureDb();
	const sessionId = sessionIdOf(ctx);
	const cwd = ctx.sessionManager.getCwd();
	const existing = getSession(db, sessionId);
	const now = Date.now();

	upsertSession(db, {
		id: sessionId,
		cwd,
		project: projectOf(cwd),
		startedAt: existing?.startedAt ?? now,
		lastAt: now,
		name: (ctx.sessionManager as any).getSessionName?.() ?? existing?.name ?? null,
	});
	state.counters.set(sessionId, maxSeq(db, sessionId));
}

/** reload 后补上 reload 期间发生的消息（INSERT OR IGNORE 天然去重）。 */
function backfillCurrentSession(ctx: ExtensionContext): number {
	const db = ensureDb();
	const sessionId = sessionIdOf(ctx);
	const branch = (ctx.sessionManager as any).getBranch?.() as any[] | undefined;
	if (!branch?.length) return 0;

	let seq = maxSeq(db, sessionId);
	let inserted = 0;

	db.exec("begin immediate");
	try {
		for (const entry of branch) {
			let rendered: { role: any; text: string; meta?: Record<string, unknown> } | null = null;
			let ts = Date.parse(entry?.timestamp ?? "") || Date.now();

			if (entry?.type === "message" && entry.message) {
				rendered = renderMessage(entry.message);
				if (typeof entry.message.timestamp === "number") ts = entry.message.timestamp;
			} else if (entry?.type === "compaction" && typeof entry.summary === "string") {
				rendered = renderSummary(entry.summary);
			}
			if (!rendered) continue;

			seq++;
			const hash = messageHash(sessionId, rendered.role, ts, rendered.text);
			if (
				insertMessage(db, {
					sessionId,
					seq,
					ts,
					role: rendered.role,
					text: rendered.text,
					hash,
					meta: rendered.meta,
				})
			) {
				inserted++;
			}
		}
		db.exec("commit");
	} catch (error) {
		try {
			db.exec("rollback");
		} catch {
			// 忽略
		}
		throw error;
	}

	state.counters.set(sessionId, seq);
	return inserted;
}

export default function piMemory(pi: ExtensionAPI) {
	// --- 生命周期 ---
	pi.on("session_start", async (event, ctx) => {
		try {
			registerSession(ctx);
			if (event.reason === "reload" || event.reason === "resume") backfillCurrentSession(ctx);
		} catch (error) {
			state.openError = error instanceof Error ? error.message : String(error);
			warnOnce(ctx, `pi-memory: 初始化失败（${state.openError}）`);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		try {
			const rendered = renderMessage(event.message);
			if (!rendered) return;
			const ts =
				typeof (event.message as any).timestamp === "number" ? (event.message as any).timestamp : Date.now();
			writeMessage(sessionIdOf(ctx), rendered, ts);
		} catch (error) {
			warnOnce(ctx, `pi-memory: 写入失败（${error instanceof Error ? error.message : String(error)}），可用 /recall import 补齐`);
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		try {
			const summary = event.compactionEntry?.summary;
			if (typeof summary !== "string" || !summary.trim()) return;
			const rendered = renderSummary(summary);
			if (!rendered) return;
			const ts = Date.parse(event.compactionEntry.timestamp ?? "") || Date.now();
			writeMessage(sessionIdOf(ctx), rendered, ts);
		} catch (error) {
			warnOnce(ctx, `pi-memory: 摘要写入失败（${error instanceof Error ? error.message : String(error)}）`);
		}
	});

	pi.on("session_shutdown", async () => {
		state.counters.clear();
		if (!state.db) return;
		try {
			state.db.close();
		} catch {
			// 已关闭
		}
		state.db = null;
		state.searcher = null;
	});

	// --- 工具 ---
	pi.registerTool(
		defineTool({
			name: "session_search",
			label: "Session Search",
			promptSnippet: "Search past session transcripts by keyword (works for Chinese, English, mixed)",
			promptGuidelines: [
				"When the user refers to past work — 「上次」「之前」「以前那个」「我们讨论过」「记得吗」, or asks what was decided earlier — call session_search before answering from memory.",
				"Do not claim you do not remember until session_search returns nothing.",
				"Pass short keywords (2–6 chars/tokens), not a full sentence: 「缓存 索引」 beats 「我们上次说的那个缓存索引的方案是什么」.",
			],
			description: [
				"搜索过去会话的记忆库（按关键词）。",
				"当用户说「上次」「之前」「以前那个」「我们讨论过」时，先用这个工具搜，不要凭记忆猜。",
				"查询传关键词或短句（例如「缓存 索引」），不要传整段自然语言。",
				"返回命中位置 + 会话信息 + msg_id；需要完整上下文时用 session_read。",
			].join("\n"),
			parameters: Type.Object({
				query: Type.String({ description: "关键词或短句" }),
				limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 10，上限 20" })),
				project: Type.Optional(Type.String({ description: "只搜某个项目（cwd 的目录名，小写）" })),
				since: Type.Optional(Type.String({ description: "只搜此日期之后的内容，格式 YYYY-MM-DD" })),
			}),
			async execute(_toolCallId, params) {
				try {
					const db = ensureDb();
					const searcher = state.searcher ?? createSearcher(db);
					const since = params.since ? Date.parse(params.since) : undefined;
					const result = searcher.search(params.query, {
						limit: params.limit,
						project: params.project?.toLowerCase(),
						since: Number.isFinite(since) ? since : undefined,
					});
					const text = formatSearch(db, result);
					return {
						content: [{ type: "text", text: text.slice(0, SEARCH_MAX_CHARS) }],
						details: {
							hits: result.hits.map((hit) => ({
								msgId: hit.id,
								sessionId: hit.sessionId,
								seq: hit.seq,
								role: hit.role,
								score: Number(hit.score.toFixed(3)),
							})),
							anchors: result.anchors,
							usedOr: result.usedOr,
							elapsedMs: Number(result.elapsedMs.toFixed(1)),
						},
					};
				} catch (error) {
					throw new Error(`session_search 失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "session_read",
			label: "Session Read",
			promptSnippet: "Read a contiguous window of a past session (use after session_search)",
			promptGuidelines: [
				"After session_search, use session_read with the returned session id and msg_id to get the surrounding conversation instead of guessing.",
			],
			description: [
				"读取某个会话的连续片段（可直接阅读的对话记录）。",
				"通常配合 session_search 的 msg_id 使用：传 around_msg_id 就能看到命中点前后的上下文。",
				"前文默认 4 条、后文默认 6 条；输出有 8K 字符上限。",
			].join("\n"),
			parameters: Type.Object({
				session_id: Type.String({ description: "session_search 返回的 session ID" }),
				around_msg_id: Type.Optional(Type.Number({ description: "命中的 msg_id，从它展开" })),
				before: Type.Optional(Type.Number({ description: "前文条数，默认 4" })),
				after: Type.Optional(Type.Number({ description: "后文条数，默认 6" })),
			}),
			async execute(_toolCallId, params) {
				try {
					const db = ensureDb();
					const text = formatSessionRead(db, params.session_id, {
						aroundMsgId: params.around_msg_id,
						before: params.before,
						after: params.after,
					});
					return {
						content: [{ type: "text", text: text.slice(0, READ_MAX_CHARS) }],
						details: { sessionId: params.session_id, aroundMsgId: params.around_msg_id ?? null },
					};
				} catch (error) {
					throw new Error(`session_read 失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
	);

	// --- /recall ---
	pi.registerCommand("recall", {
		description: "查记忆库：/recall <关键词> | /recall stats | /recall import",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();

			// 无 UI 模式（print/json/rpc）下 notify 是空操作，改写进会话流，避免静默失效
			const say = (text: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) {
					ctx.ui.notify(text, level);
					return;
				}
				pi.sendMessage({ customType: "pi-memory", content: text, display: true }, { triggerTurn: false });
			};

			if (!input) {
				say("用法: /recall <关键词> | /recall stats | /recall import");
				return;
			}

			try {
				const db = ensureDb();

				if (input === "stats") {
					const s = stats(db, dbFile());
					say(
						[
							`库: ${dbFile()}`,
							`消息 ${s.messages} 条 / 会话 ${s.sessions} 个 / 体积 ${(s.bytes / 1048576).toFixed(1)}MB`,
							s.oldest
								? `范围: ${new Date(s.oldest).toISOString().slice(0, 10)} → ${new Date(s.newest!).toISOString().slice(0, 10)}`
								: "库为空（用 /recall import 导入历史）",
						].join("\n"),
					);
					return;
				}

				if (input === "import") {
					say("正在导入历史会话（分批写入，可继续使用）…");
					const result = await importSessions(db, sessionsRoot());
					state.counters.clear();
					say(
						`导入完成：${result.files} 个文件，新增 ${result.inserted} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 个文件`,
						result.failed ? "warning" : "info",
					);
					return;
				}

				const searcher = state.searcher ?? createSearcher(db);
				const result = searcher.search(input, { limit: 10 });
				say(formatSearch(db, result).slice(0, SEARCH_MAX_CHARS));
			} catch (error) {
				say(`pi-memory: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// 供测试/诊断使用（不注册成工具）
	(globalThis as any).__piMemory = {
		version: SCHEMA_VERSION,
		dbFile,
		sessionsRoot,
		state,
		backfillCurrentSession,
		writeMessage,
		registerSession,
	};
}

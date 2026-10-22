import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
	getSession,
	insertMessage,
	maxSeq,
	messageHash,
	openDb,
	projectOf,
	readWindow,
	stats,
	upsertSession,
} from "../src/db.ts";
import { formatSearch, formatSessionRead, relTime, snippet } from "../src/format.ts";
import { renderMessage, renderSummary } from "../src/render.ts";
import { createSearcher } from "../src/search.ts";
import { termsOf } from "../src/tokenize.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
const dbs: DatabaseSync[] = [];

function freshDb(): DatabaseSync {
	const file = path.join(tmpRoot, `db-${dbs.length}.sqlite`);
	const db = openDb(file);
	dbs.push(db);
	return db;
}

after(() => {
	for (const db of dbs) {
		try {
			db.close();
		} catch {
			/* 已关闭 */
		}
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 每条消息用全局递增 ts，seq 按会话独立递增——和真实写入一致
let tsCursor = 1_700_000_000_000;

function add(db: DatabaseSync, sessionId: string, role: any, text: string, extra?: { project?: string }) {
	const seq = maxSeq(db, sessionId) + 1;
	const stamp = (tsCursor += 1000);
	if (extra?.project) {
		upsertSession(db, {
			id: sessionId,
			cwd: `/w/${extra.project}`,
			project: extra.project,
			startedAt: stamp,
			lastAt: stamp,
		});
	}
	return insertMessage(db, {
		sessionId,
		seq,
		ts: stamp,
		role,
		text,
		hash: messageHash(sessionId, role, stamp, text),
	});
}

describe("tokenize", () => {
	it("中文按双字切分，单字进召回通道", () => {
		const { chars, grams } = termsOf("缓存索引");
		assert.deepEqual(chars, ["缓", "存", "索", "引"]);
		assert.deepEqual(grams, ["缓存", "存索", "索引"]);
	});

	it("拉丁词同时进两个通道", () => {
		const { chars, grams } = termsOf("SQLite FTS5 x");
		assert.deepEqual(chars, ["sqlite", "fts5"]);
		assert.deepEqual(grams, ["sqlite", "fts5"]);
	});

	it("中英混排各走各的", () => {
		const { chars, grams } = termsOf("Vue 组件响应式");
		assert.deepEqual(chars, ["vue", "组", "件", "响", "应", "式"]);
		assert.ok(grams.includes("vue"));
		assert.ok(grams.includes("组件"));
		assert.ok(grams.includes("响应"));
	});

	it("单个汉字不会产生双字", () => {
		const { chars, grams } = termsOf("锁");
		assert.deepEqual(chars, ["锁"]);
		assert.deepEqual(grams, []);
	});

	it("空输入安全", () => {
		assert.deepEqual(termsOf(""), { chars: [], grams: [] });
	});

	it("不拆代理对", () => {
		const { chars } = termsOf("𠀀𠀁");
		assert.equal(chars.length, 2);
	});
});

describe("render", () => {
	it("user 文本保留原文", () => {
		const r = renderMessage({ role: "user", content: "帮我看下这个方案", timestamp: 1 });
		assert.deepEqual(r, { role: "user", text: "帮我看下这个方案" });
	});

	it("assistant 跳过 thinking，保留文本与工具调用", () => {
		const r = renderMessage({
			role: "assistant",
			model: "test-model",
			content: [
				{ type: "thinking", thinking: "内部推理不该入库" },
				{ type: "text", text: "先读文件" },
				{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
			],
			timestamp: 1,
		});
		assert.ok(r);
		assert.equal(r.role, "assistant");
		assert.ok(!r.text.includes("内部推理"));
		assert.ok(r.text.includes("先读文件"));
		assert.ok(r.text.includes("→ read("));
		assert.deepEqual(r.meta, { model: "test-model", toolCalls: 1 });
	});

	it("成功的 toolResult 不入库", () => {
		assert.equal(renderMessage({ role: "toolResult", toolName: "bash", isError: false, content: [] }), null);
	});

	it("失败的 toolResult 入库并截断", () => {
		const r = renderMessage({
			role: "toolResult",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "x".repeat(2000) }],
		});
		assert.ok(r);
		assert.equal(r.role, "tool_error");
		assert.ok(r.text.startsWith("✗ bash:"));
		assert.ok(r.text.length < 700);
	});

	it("system 与 custom 不入库", () => {
		assert.equal(renderMessage({ role: "system", content: "prompt" }), null);
		assert.equal(renderMessage({ role: "custom", customType: "x", content: "y" }), null);
	});

	it("图片记成占位符", () => {
		const r = renderMessage({
			role: "user",
			content: [
				{ type: "text", text: "看这个" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		});
		assert.equal(r?.text, "看这个\n[图片]");
	});

	it("不做脱敏：密钥原样保留（可搜）", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwx";
		const r = renderMessage({ role: "user", content: `我的 key 是 ${secret}` });
		assert.equal(r?.text, `我的 key 是 ${secret}`);
		const bearer = "Bearer abcdefghijklmnopqrstuvwxyz123";
		assert.equal(renderMessage({ role: "user", content: bearer })?.text, bearer);
		const kv = "api_key: abcdefghijklmnopqrst";
		assert.equal(renderMessage({ role: "user", content: kv })?.text, kv);
	});

	it("摘要走单独入口", () => {
		const r = renderSummary("## Goal\n修复断流");
		assert.equal(r?.role, "summary");
		assert.equal(renderSummary("   "), null);
	});
});

describe("db", () => {
	it("建立 schema 并记录版本", () => {
		const db = freshDb();
		const row = db.prepare("pragma user_version").get() as { user_version: number };
		assert.equal(Number(row.user_version), 1);
	});

	it("相同 hash 幂等，重复写入不产生新行", () => {
		const db = freshDb();
		const one = { sessionId: "s1", seq: 1, ts: 1_700_000_000_000, role: "user" as const, text: "重复的内容" };
		const hash = messageHash(one.sessionId, one.role, one.ts, one.text);
		assert.equal(insertMessage(db, { ...one, hash }), true);
		assert.equal(insertMessage(db, { ...one, hash }), false);
		const count = db.prepare("select count(*) as c from msg").get() as { c: number };
		assert.equal(count.c, 1);
	});

	it("FTS rowid 与 msg.id 对齐", () => {
		const db = freshDb();
		add(db, "s1", "user", "缓存索引的设计");
		const row = db.prepare("select rowid from msg_fts").get() as { rowid: number };
		const msg = db.prepare("select id from msg").get() as { id: number };
		assert.equal(Number(row.rowid), Number(msg.id));
	});

	it("idx=0 也能命中（列过滤在 join 下可用）", () => {
		const db = freshDb();
		add(db, "s1", "user", "缓存索引的设计");
		const hit = db
			.prepare("select count(*) as c from msg_fts where msg_fts match ?")
			.get('chars:("缓")') as { c: number };
		assert.equal(hit.c, 1);
	});

	it("seq 按会话独立递增，窗口读取按 seq 排序", () => {
		const db = freshDb();
		for (const text of ["第一", "第二", "第三"]) add(db, "s1", "user", text);
		assert.equal(maxSeq(db, "s1"), 2);
		add(db, "s2", "user", "另一个会话");
		assert.equal(maxSeq(db, "s2"), 0, "不同会话的 seq 互不影响");
		const rows = readWindow(db, "s1", 0, 10);
		assert.deepEqual(
			rows.map((r) => r.text),
			["第一", "第二", "第三"],
		);
	});

	it("会话 upsert 更新 last_at 但不丢 started_at", () => {
		const db = freshDb();
		upsertSession(db, { id: "s1", cwd: "/w/a", project: "a", startedAt: 100, lastAt: 100 });
		upsertSession(db, { id: "s1", cwd: "/w/a", project: "a", startedAt: 999, lastAt: 200 });
		const meta = getSession(db, "s1");
		assert.equal(meta?.startedAt, 100);
		assert.equal(meta?.lastAt, 200);
	});

	it("projectOf 取目录名小写", () => {
		assert.equal(projectOf("C:\\Users\\x\\codes\\Pi-Memory\\"), "pi-memory");
		assert.equal(projectOf("/home/x/repo"), "repo");
	});

	it("stats 统计条数与体积", () => {
		const db = freshDb();
		add(db, "s1", "user", "一句话");
		const s = stats(db, path.join(tmpRoot, "db-0.sqlite"));
		assert.equal(s.messages, 1);
		assert.ok(s.bytes > 0);
	});
});

describe("search", () => {
	function corpus() {
		const db = freshDb();
		const rows: Array<[string, string, string, string]> = [
			["sA", "proj-a", "user", "我们讨论一下缓存索引的方案，先看现有的缓存层怎么写入"],
			["sA", "proj-a", "assistant", "缓存索引可以按会话分片，索引放在 WAL 后面"],
			["sA", "proj-a", "user", "好，那就按这个方案做"],
			["sB", "proj-b", "user", "响应式系统是怎么实现依赖收集的"],
			["sB", "proj-b", "assistant", "响应式靠 Proxy 拦截 get 来收集依赖，组件渲染时触发"],
			["sC", "proj-b", "user", "the whale surfaced near the boat at dawn"],
			["sC", "proj-b", "assistant", "the sea was calm and the whale went down again"],
			["sD", "proj-a", "user", "数据库连接池的锁超时问题"],
		];
		for (const [sid, project, role, text] of rows) add(db, sid, role, text, { project });
		db.exec("update session set name = '缓存设计' where id = 'sA'");
		return { db, searcher: createSearcher(db) };
	}

	it("中文关键词命中", () => {
		const { searcher } = corpus();
		const result = searcher.search("缓存索引");
		assert.ok(result.hits.length >= 2);
		assert.ok(result.hits.every((h) => h.sessionId === "sA"));
		assert.equal(result.hits[0].score, 1);
	});

	it("英文关键词命中", () => {
		const { searcher } = corpus();
		const result = searcher.search("whale sea");
		assert.ok(result.hits.length >= 1);
		assert.ok(result.hits[0].text.includes("whale"));
	});

	it("长自然语言查询不会 0 命中（锚点策略）", () => {
		const { searcher } = corpus();
		const result = searcher.search("我一直搞不清楚响应式是怎么实现依赖收集的");
		assert.ok(result.hits.length > 0, "长查询必须仍能召回");
		assert.ok(result.hits[0].sessionId === "sB");
	});

	it("单字查询可用", () => {
		const { searcher } = corpus();
		const result = searcher.search("锁");
		assert.ok(result.hits.length > 0);
	});

	it("AND 无果时降级为 OR 并标记", () => {
		const { searcher } = corpus();
		const result = searcher.search("鲸鱼和不存在的量子纠缠");
		assert.equal(result.usedOr, true);
		assert.ok(result.hits.length > 0);
	});

	it("project 过滤生效", () => {
		const { searcher } = corpus();
		const result = searcher.search("缓存", { project: "proj-b" });
		assert.equal(result.hits.length, 0);
		const scoped = searcher.search("响应式", { project: "proj-b" });
		assert.ok(scoped.hits.length > 0);
	});

	it("limit 生效", () => {
		const { searcher } = corpus();
		const result = searcher.search("缓存", { limit: 1 });
		assert.equal(result.hits.length, 1);
	});

	it("无匹配返回空而不是抛错", () => {
		const { searcher } = corpus();
		const result = searcher.search("zzzznotexist");
		assert.deepEqual(result.hits, []);
	});

	it("空查询返回空", () => {
		const { searcher } = corpus();
		assert.deepEqual(searcher.search("   ").hits, []);
	});

	it("df 越大越不当锚点：稀有字优先", () => {
		const { searcher } = corpus();
		const result = searcher.search("的缓存索引方案");
		assert.ok(result.anchors.includes("缓"));
		assert.ok(!result.anchors.includes("的"), "高频字不该被选成锚点");
	});

	it("检索耗时有上界（合成 2000 条）", () => {
		const db = freshDb();
		const filler = "缓存索引的分片策略和写入路径需要考虑锁与预写日志的行为";
		for (let i = 0; i < 2000; i++) add(db, `s${i % 20}`, "user", `${filler} 第${i}条`);
		const searcher = createSearcher(db);
		const started = Date.now();
		const result = searcher.search("缓存索引 锁");
		const elapsed = Date.now() - started;
		assert.ok(result.hits.length > 0);
		assert.ok(elapsed < 300, `2000 条库上单次查询应在 300ms 内，实际 ${elapsed}ms`);
	});
});

describe("format", () => {
	it("片段高亮命中词", () => {
		const out = snippet("前文".repeat(200) + "缓存索引" + "后文".repeat(200), ["缓存"]);
		assert.ok(out.includes("【缓存】"));
		assert.ok(out.startsWith("…"));
	});

	it("无命中词时退化为开头截断", () => {
		const out = snippet("普通内容", ["不存在"]);
		assert.equal(out, "普通内容");
	});

	it("相对时间", () => {
		const now = Date.now();
		assert.equal(relTime(now), "刚刚");
		assert.equal(relTime(now - 3600_000), "1 小时前");
		assert.equal(relTime(now - 86400_000 * 3), "3 天前");
	});

	it("检索输出包含会话头、msg_id 和 8 位 session", () => {
		const db = freshDb();
		add(db, "01a1632f-dead-beef", "user", "缓存索引怎么写", { project: "demo" });
		const searcher = createSearcher(db);
		const text = formatSearch(db, searcher.search("缓存索引"));
		assert.ok(text.includes("session=01a1632f"));
		assert.ok(text.includes("msg_id="));
		assert.ok(text.includes("【缓存】"));
	});

	it("无命中时给出明确文案", () => {
		const db = freshDb();
		const text = formatSearch(db, createSearcher(db).search("任何东西"));
		assert.equal(text, "无命中。");
	});

	it("会话读取带头部、条数与窗口范围", () => {
		const db = freshDb();
		upsertSession(db, { id: "s1", cwd: "/w/demo", project: "demo", startedAt: 1_700_000_000_000, lastAt: 1_700_000_000_000 });
		for (const t of ["一", "二", "三"]) add(db, "s1", "user", t);
		const out = formatSessionRead(db, "s1");
		assert.ok(out.includes("共 3 条"));
		assert.ok(out.includes("#1 user"));
		assert.ok(out.includes("窗口 #0–#2"));
	});

	it("未知会话给出提示而不是抛错", () => {
		const db = freshDb();
		assert.ok(formatSessionRead(db, "nope").includes("未知会话"));
	});

	it("session_read 接受 8 位短 id（列表里就是这么显示的）", () => {
		const db = freshDb();
		const full = "01a163e9-88a0-7099-9267-d92c5da6df73";
		upsertSession(db, { id: full, cwd: "/w/demo", project: "demo", startedAt: 1_700_000_000_000, lastAt: 1_700_000_000_000 });
		add(db, full, "user", "缓存索引按会话分片");
		const out = formatSessionRead(db, "01a163e9");
		assert.ok(out.includes("缓存索引按会话分片"), out);
		assert.ok(out.includes("共 1 条"));
		assert.ok(out.includes("按前缀匹配"));
		assert.ok(out.includes(full), "头部应给出完整 id 方便后续调用");
	});

	it("session_read 前缀歧义时报候选而不是瞎选", () => {
		const db = freshDb();
		for (const id of ["01a1aaaa-0000", "01a1bbbb-0000"]) {
			upsertSession(db, { id, cwd: "/w/demo", project: "demo", startedAt: 1, lastAt: 1 });
		}
		const out = formatSessionRead(db, "01a1");
		assert.ok(out.includes("不唯一"), out);
		assert.ok(out.includes("01a1aaaa-0000"));
	});

	it("around_msg_id 不属于该会话时忽略锚点", () => {
		const db = freshDb();
		for (const id of ["sA", "sB"]) {
			upsertSession(db, { id, cwd: "/w/demo", project: "demo", startedAt: 1, lastAt: 1 });
		}
		add(db, "sA", "user", "会话 A 的内容");
		const foreign = add(db, "sB", "user", "会话 B 的内容");
		const foreignId = Number((db.prepare("select id from msg where session_id='sB'").get() as any).id);
		const out = formatSessionRead(db, "sA", { aroundMsgId: foreignId });
		assert.ok(out.includes("会话 A 的内容"));
		assert.ok(!out.includes("会话 B 的内容"));
		assert.ok(foreign);
	});
});

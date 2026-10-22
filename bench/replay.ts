/**
 * 端到端回放：把真实 pi session jsonl 导入临时库，跑真实查询。
 * 用法: node --no-warnings index.ts 不需要；这里只测 src/。
 *   node --no-warnings bench/replay.ts [sessionsRoot]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, stats } from "../src/db.ts";
import { formatSearch, formatSessionRead } from "../src/format.ts";
import { findSessionFiles, importSessions } from "../src/import.ts";
import { createSearcher } from "../src/search.ts";

const root = process.argv[2] || path.join(os.homedir(), ".pi", "agent", "sessions");
const file = path.join(os.tmpdir(), `pi-memory-replay-${Date.now()}.sqlite`);

if (!fs.existsSync(root)) {
	console.error(`没有找到 sessions 目录: ${root}`);
	process.exit(1);
}

const files = findSessionFiles(root);
console.log(`sessions root: ${root}`);
console.log(`jsonl 文件: ${files.length} 个`);

const db = openDb(file);

const t0 = process.hrtime.bigint();
const result = await importSessions(db, root);
const importMs = Number(process.hrtime.bigint() - t0) / 1e6;

const s = stats(db, file);
console.log(
	`导入: ${result.files} 文件 / 新增 ${result.inserted} 条 / 跳过 ${result.skipped} 条 / 失败 ${result.failed} 个，耗时 ${importMs.toFixed(0)}ms`,
);
console.log(
	`库: ${(s.bytes / 1048576).toFixed(1)}MB, 消息 ${s.messages} 条, 会话 ${s.sessions} 个`,
);

const searcher = createSearcher(db);

// 幂等性：再导一次不应新增
const again = await importSessions(db, root);
console.log(`重复导入: 新增 ${again.inserted} 条（应为 0）`);

const queries = process.argv.slice(3);
const defaults = ["缓存", "索引", "方案", "扩展", "会话", "sqlite", "测试", "错误"];
for (const q of queries.length ? queries : defaults) {
	const r = searcher.search(q, { limit: 5 });
	console.log(
		`\n=== "${q}" → ${r.hits.length} 命中, 锚点=[${r.anchors.join(" ")}], ${r.elapsedMs.toFixed(1)}ms, usedOr=${r.usedOr}`,
	);
	if (!r.hits.length) {
		console.log("  (无命中)");
		continue;
	}
	console.log(formatSearch(db, r));
	if (r.hits[0]) {
		const read = formatSessionRead(db, r.hits[0].sessionId, { aroundMsgId: r.hits[0].id, before: 1, after: 2 });
		console.log("\n--- session_read 片段 ---");
		console.log(read.split("\n").slice(0, 14).join("\n"));
	}
}

// 性能分布
console.log("\n=== 延迟分布（各 20 次）");
for (const q of ["缓存", "索引 方案", "sqlite 索引 性能", "我一直搞不清楚这个缓存是怎么工作的"]) {
	const times: number[] = [];
	for (let i = 0; i < 20; i++) {
		const a = process.hrtime.bigint();
		searcher.search(q, { limit: 10 });
		times.push(Number(process.hrtime.bigint() - a) / 1e6);
	}
	times.sort((a, b) => a - b);
	console.log(`  "${q}"  p50=${times[10].toFixed(1)}ms  p95=${times[18].toFixed(1)}ms  max=${times[19].toFixed(1)}ms`);
}

db.close();
fs.rmSync(file, { force: true });
try {
	fs.rmSync(`${file}-wal`, { force: true });
	fs.rmSync(`${file}-shm`, { force: true });
} catch {
	/* 已清理 */
}

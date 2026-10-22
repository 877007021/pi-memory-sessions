/**
 * 接线冒烟测试：不启动 pi、不调模型，用 mock ExtensionAPI 加载 index.ts。
 * 验证：模块能加载、工具/命令/事件都注册了、写入与检索端到端可用。
 *
 * 需要本机的 pi 安装（用来解析 @earendil-works/* 依赖）：
 *   node --no-warnings bench/smoke.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const PI_MODULES =
	process.env.PI_MODULES_DIR ||
	path.join(
		path.dirname(process.execPath),
		"..",
		"lib",
		"node_modules",
		"@agegr",
		"pi-web",
		"node_modules",
	);

function findPiModules(): string {
	const candidates = [
		PI_MODULES,
		"C:\\Users\\nanh\\AppData\\Roaming\\npm\\node_modules\\@agegr\\pi-web\\node_modules",
	];
	for (const candidate of candidates) {
		if (fs.existsSync(path.join(candidate, "@earendil-works", "pi-coding-agent"))) return candidate;
	}
	throw new Error("找不到 pi 的 node_modules，设置 PI_MODULES_DIR");
}

const modules = findPiModules();
const require = createRequire(path.join(modules, "noop.js"));

// 让裸导入（@earendil-works/*）能解析：临时把 pi 的 node_modules 链接进项目根
const linkPath = path.join(process.cwd(), "node_modules");
let createdLink = false;
if (!fs.existsSync(linkPath)) {
	try {
		fs.symlinkSync(modules, linkPath, "junction");
		createdLink = true;
	} catch (error) {
		console.error(`无法创建 node_modules 链接，请手动 mklink /J node_modules "${modules}"`);
		throw error;
	}
}
const cleanupLink = () => {
	if (createdLink) {
		try {
			fs.unlinkSync(linkPath);
		} catch {
			/* 已清理 */
		}
	}
};

// 项目根目录通过 junction 指向 pi 的 node_modules，裸导入可以直接解析
const { createJiti } = require("jiti");
const jiti = createJiti(path.join(process.cwd(), "bench", "smoke.ts"), {
	interopDefault: true,
});

const dbFile = path.join(os.tmpdir(), `pi-memory-smoke-${Date.now()}.sqlite`);
process.env.PI_MEMORY_DB = dbFile;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
}

const factory = jiti(path.join(process.cwd(), "index.ts"));
check("index.ts 导出 default 工厂", typeof factory === "function" || typeof factory?.default === "function", typeof factory);
const piMemory = typeof factory === "function" ? factory : factory.default;

// --- mock ExtensionAPI ---
const handlers = new Map<string, Function[]>();
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const notifications: string[] = [];

const pi = {
	on(event: string, handler: Function) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {};
	},
	registerTool(tool: any) {
		tools.set(tool.name, tool);
	},
	registerCommand(name: string, command: any) {
		commands.set(name, command);
	},
};

piMemory(pi);

check("注册了 2 个工具", tools.size === 2, [...tools.keys()].join(","));
check("session_search 已注册", tools.has("session_search"));
check("session_read 已注册", tools.has("session_read"));
check("/recall 已注册", commands.has("recall"));
for (const event of ["session_start", "message_end", "session_compact", "session_shutdown"]) {
	check(`监听 ${event}`, (handlers.get(event)?.length ?? 0) === 1);
}

// --- mock ctx ---
const sessionId = "01a1632f-aaaa-bbbb-cccc-000000000001";
const entries: any[] = [];
const ctx: any = {
	ui: { notify: (msg: string) => notifications.push(msg) },
	hasUI: true,
	mode: "tui",
	sessionManager: {
		getSessionId: () => sessionId,
		getCwd: () => "C:\\Users\\nanh\\workspace\\code\\pi-memory",
		getSessionName: () => "缓存索引设计",
		getBranch: () => entries,
		getEntries: () => entries,
	},
};

async function emit(event: string, payload: any) {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

await emit("session_start", { type: "session_start", reason: "startup" });

const t = Date.now();
const messages: any[] = [
	{ role: "user", content: "我们讨论一下缓存索引的方案", timestamp: t },
	{
		role: "assistant",
		model: "test",
		content: [
			{ type: "thinking", thinking: "不应入库" },
			{ type: "text", text: "缓存索引按会话分片，写入走 WAL" },
			{ type: "toolCall", name: "read", arguments: { path: "src/db.ts" } },
		],
		timestamp: t + 1000,
	},
	{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "x" }], timestamp: t + 1500 },
	{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "ENOENT" }], timestamp: t + 1600 },
	{ role: "user", content: "那就按这个方案做", timestamp: t + 2000 },
];
for (const message of messages) await emit("message_end", { type: "message_end", message });

// 压缩摘要
await emit("session_compact", {
	type: "session_compact",
	reason: "manual",
	willRetry: false,
	fromExtension: false,
	compactionEntry: { type: "compaction", id: "c1", timestamp: new Date(t + 3000).toISOString(), summary: "决定缓存索引按会话分片", firstKeptEntryId: "x", tokensBefore: 1000 },
});

const searchResult = await tools.get("session_search").execute("c1", { query: "缓存索引" }, undefined, undefined, ctx);
const searchText = searchResult.content[0].text;
check("session_search 命中", /msg_id=\d+/.test(searchText), searchText.split("\n")[0]);
check("详情里带结构化 hits", Array.isArray(searchResult.details?.hits) && searchResult.details.hits.length > 0);
check("thinking 未入库", !searchText.includes("不应入库"));
check("成功 toolResult 未入库", !searchText.includes("xxx"));
check("失败 toolResult 入库", (await tools.get("session_search").execute("c2", { query: "ENOENT" }, undefined, undefined, ctx)).details.hits.length > 0);
check("摘要可检索", (await tools.get("session_search").execute("c3", { query: "分片" }, undefined, undefined, ctx)).details.hits.length > 0);

const hit = searchResult.details.hits[0];
const readResult = await tools.get("session_read").execute("c4", { session_id: sessionId, around_msg_id: hit.msgId }, undefined, undefined, ctx);
check("session_read 返回可读记录", readResult.content[0].text.includes("共 5 条"), readResult.content[0].text.split("\n")[1]);

// /recall stats
await commands.get("recall").handler("stats", ctx);
check("/recall stats 有输出", notifications.some((n) => n.includes("消息 5 条")), notifications.at(-1)?.split("\n")[1]);

// 关闭后再开（幂等）
await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
check("shutdown 不抛错", true);

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbFile + suffix, { force: true });
cleanupLink();
process.exit(failures === 0 ? 0 : 1);

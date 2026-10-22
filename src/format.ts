/**
 * 检索结果 → 模型/人类可读的文本。
 * 所有输出都有硬字符预算，避免把上下文塞爆。
 */

import type { DatabaseSync } from "node:sqlite";
import { type MsgRow, getMessage, resolveSession } from "./db.ts";
import type { Hit, SearchResult } from "./search.ts";

export const SEARCH_MAX_CHARS = 6000;
export const READ_MAX_CHARS = 8000;
export const READ_MSG_MAX_CHARS = 1500;
const SNIPPET_RADIUS = 150;
const MAX_SESSIONS_IN_RESULT = 5;

const pad = (n: number) => String(n).padStart(2, "0");

export function absTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relTime(ts: number, now = Date.now()): string {
	const seconds = Math.max(0, now - ts) / 1000;
	if (seconds < 60) return "刚刚";
	if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
	if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
	if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))} 个月前`;
	return `${Math.floor(seconds / (86400 * 365))} 年前`;
}

function shortenCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.toLowerCase().startsWith(home.toLowerCase())) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/** 在命中词周围截一段，并把第一个命中词包进【】。 */
export function snippet(text: string, grams: string[], radius = SNIPPET_RADIUS): string {
	const lower = text.toLowerCase();
	let at = -1;
	let term = "";
	for (const gram of grams) {
		const index = lower.indexOf(gram);
		if (index >= 0 && (at < 0 || index < at)) {
			at = index;
			term = gram;
		}
	}
	if (at < 0) {
		const head = text.slice(0, radius * 2);
		return (head.trim() + (text.length > head.length ? "…" : "")).replace(/\s+/g, " ");
	}

	const start = Math.max(0, at - radius);
	const end = Math.min(text.length, at + term.length + radius);
	const raw = text.slice(start, end);
	const offset = at - start;
	const marked =
		raw.slice(0, offset) + "【" + raw.slice(offset, offset + term.length) + "】" + raw.slice(offset + term.length);
	return `${start > 0 ? "…" : ""}${marked.replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

export function formatSearch(db: DatabaseSync, result: SearchResult): string {
	if (!result.hits.length) return "无命中。";

	const lines: string[] = [`命中 ${result.hits.length} 条（${result.elapsedMs.toFixed(1)}ms）`];
	const bySession = new Map<string, Hit[]>();
	for (const hit of result.hits) {
		const list = bySession.get(hit.sessionId);
		if (list) list.push(hit);
		else bySession.set(hit.sessionId, [hit]);
	}

	let sessions = 0;
	let chars = lines[0].length;
	for (const [sessionId, hits] of bySession) {
		if (sessions >= MAX_SESSIONS_IN_RESULT) break;
		const meta = resolveSession(db, sessionId);
		const resolvedMeta = meta && !("ambiguous" in meta) ? meta.meta : undefined;
		const header = resolvedMeta
			? `\n[${absTime(resolvedMeta.startedAt)} · ${relTime(resolvedMeta.lastAt)} · ${shortenCwd(resolvedMeta.cwd)}${resolvedMeta.name ? ` · "${resolvedMeta.name}"` : ""}] session=${sessionId.slice(0, 8)}`
			: `\n[session=${sessionId.slice(0, 8)}]`;
		if (chars + header.length > SEARCH_MAX_CHARS) break;
		lines.push(header);
		chars += header.length;
		sessions++;

		for (const hit of hits) {
			const line = `  #${hit.seq} ${hit.role} msg_id=${hit.id} score=${hit.score.toFixed(2)}\n    ${snippet(hit.text, result.grams)}`;
			if (chars + line.length > SEARCH_MAX_CHARS) {
				lines.push("  …（输出已截断，用 session_read 看完整上下文）");
				return lines.join("\n");
			}
			lines.push(line);
			chars += line.length;
		}
	}

	if (result.usedOr) lines.push("\n注：精确匹配无结果，已放宽为任一锚点命中。");
	return lines.join("\n");
}

/**
 * 读一个会话的连续窗口。
 * "为什么出现"= 命中点之前最近的 user 消息，所以默认 before 比 after 小。
 */
export function formatSessionRead(
	db: DatabaseSync,
	sessionId: string,
	options: { aroundMsgId?: number; before?: number; after?: number } = {},
): string {
	const resolved = resolveSession(db, sessionId);
	if (!resolved) {
		return `未知会话 ${sessionId}（可能还没被捕获，或已被删除）。可用 /recall <关键词> 先搜到会话 id。`;
	}
	if ("ambiguous" in resolved) {
		return `会话 id 前缀 ${sessionId} 不唯一，候选：${resolved.ambiguous.join(", ")}。请传完整 id。`;
	}
	const meta = resolved.meta;

	// 锚点必须属于这个会话，否则窗口位置是错的
	const candidate = options.aroundMsgId != null ? getMessage(db, options.aroundMsgId) : undefined;
	const anchor = candidate && candidate.session_id === meta.id ? candidate : undefined;
	const total = (
		db.prepare("select count(*) as c from msg where session_id = ?").get(meta.id) as { c: number }
	).c;

	let from: number;
	let to: number;
	if (anchor) {
		from = Math.max(0, anchor.seq - (options.before ?? 4));
		to = anchor.seq + (options.after ?? 6);
	} else {
		// 没有锚点：给会话最新的一段
		const last = Number(
			(db.prepare("select coalesce(max(seq), 0) as m from msg where session_id = ?").get(meta.id) as { m: number }).m,
		);
		from = Math.max(0, last - 10);
		to = last;
	}

	const rows = db
		.prepare(
			"select id, session_id, seq, ts, role, text from msg where session_id = ? and seq between ? and ? order by seq",
		)
		.all(meta.id, from, to) as MsgRow[];

	const header = [
		`# ${absTime(meta.startedAt)} · ${relTime(meta.lastAt)} · ${shortenCwd(meta.cwd)}${meta.name ? ` · "${meta.name}"` : ""}`,
		`# session=${meta.id}  共 ${total} 条  窗口 #${from}–#${to}${resolved.exact ? "" : "  (按前缀匹配)"}`,
	].join("\n");

	let chars = header.length;
	const lines = [header];
	for (const row of rows) {
		const body =
			row.text.length > READ_MSG_MAX_CHARS ? `${row.text.slice(0, READ_MSG_MAX_CHARS)}…` : row.text;
		const line = `\n[#${row.seq} ${row.role} ${absTime(row.ts)}]\n${body}`;
		if (chars + line.length > READ_MAX_CHARS) {
			lines.push("\n…（已达输出上限，用 around_msg_id 缩小窗口）");
			break;
		}
		lines.push(line);
		chars += line.length;
	}
	return lines.join("\n");
}

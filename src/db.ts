/**
 * SQLite 存储层。
 *
 * 派生物，不是唯一真相：写失败可以随时从 jsonl 重新导入。
 * 但正常路径上永不读取 jsonl。
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemRole } from "./render.ts";
import { indexTokens, termsOf } from "./tokenize.ts";

export const SCHEMA_VERSION = 1;

// msg.nchars 是字符数；FTS 的两列叫 chars/grams。
// 刻意不重名：FTS5 的 `chars:(...)` 列过滤在 join 里不该和普通列混淆。
const SCHEMA = `
create table if not exists session (
  id         text primary key,
  cwd        text not null,
  project    text not null,
  started_at integer not null,
  last_at    integer not null,
  name       text
);

create table if not exists msg (
  id         integer primary key,
  session_id text    not null,
  seq        integer not null,
  ts         integer not null,
  role       text    not null,
  text       text    not null,
  nchars     integer not null,
  meta       text,
  hash       text    not null,
  unique(session_id, hash)
);

create index if not exists msg_session_seq on msg(session_id, seq);

create virtual table if not exists msg_fts using fts5(
  chars,
  grams,
  content='',
  contentless_delete=1
);
`;

export interface SessionMeta {
	id: string;
	cwd: string;
	project: string;
	startedAt: number;
	lastAt: number;
	name?: string | null;
}

export interface NewMessage {
	sessionId: string;
	seq: number;
	ts: number;
	role: MemRole;
	text: string;
	hash: string;
	meta?: Record<string, unknown>;
}

export interface MsgRow {
	id: number;
	session_id: string;
	seq: number;
	ts: number;
	role: string;
	text: string;
}

export function openDb(file: string): DatabaseSync {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec("pragma journal_mode = WAL");
	db.exec("pragma synchronous = NORMAL");
	db.exec("pragma busy_timeout = 5000");

	const row = db.prepare("pragma user_version").get() as { user_version?: number } | undefined;
	const version = Number(row?.user_version ?? 0);
	if (version > SCHEMA_VERSION) {
		db.close();
		throw new Error(
			`pi-memory: database schema v${version} is newer than this extension supports (v${SCHEMA_VERSION}). Upgrade the extension.`,
		);
	}

	try {
		db.exec(SCHEMA);
	} catch (error) {
		// 不同 Node 构建的内置 SQLite 可能没有 FTS5 / contentless_delete，
		// 原始报错对用户没有意义，这里给可执行的提示。
		db.close();
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`pi-memory: cannot initialize the index at ${file} (${detail}).\n` +
				`This extension needs Node >= 22.19 with FTS5 and contentless_delete (SQLite >= 3.43). ` +
				`Current Node: ${process.version}. Set PI_MEMORY_DB to another path or upgrade Node.`,
		);
	}

	if (version !== SCHEMA_VERSION) db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
	return db;
}

export function messageHash(sessionId: string, role: string, ts: number, text: string): string {
	const inner = createHash("sha1").update(text).digest("hex");
	return createHash("sha1").update(`${sessionId}:${role}:${ts}:${inner}`).digest("hex").slice(0, 16);
}

/** 调用方负责事务。 */
export function insertMessage(db: DatabaseSync, m: NewMessage): boolean {
	const tokens = indexTokens(termsOf(m.text));
	const result = db
		.prepare(
			"insert or ignore into msg(session_id, seq, ts, role, text, nchars, meta, hash) values (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			m.sessionId,
			m.seq,
			m.ts,
			m.role,
			m.text,
			m.text.length,
			m.meta ? JSON.stringify(m.meta) : null,
			m.hash,
		);

	if (!result.changes) return false;
	db.prepare("insert into msg_fts(rowid, chars, grams) values (?, ?, ?)").run(
		Number(result.lastInsertRowid),
		tokens.chars,
		tokens.grams,
	);
	return true;
}

export function upsertSession(db: DatabaseSync, s: SessionMeta): void {
	db.prepare(
		`insert into session(id, cwd, project, started_at, last_at, name)
		 values (?, ?, ?, ?, ?, ?)
		 on conflict(id) do update set
		   cwd        = excluded.cwd,
		   project    = excluded.project,
		   last_at    = max(session.last_at, excluded.last_at),
		   name       = coalesce(excluded.name, session.name)`,
	).run(s.id, s.cwd, s.project, s.startedAt, s.lastAt, s.name ?? null);
}

export function touchSession(db: DatabaseSync, id: string, ts: number): void {
	db.prepare("update session set last_at = max(last_at, ?) where id = ?").run(ts, id);
}

export function maxSeq(db: DatabaseSync, sessionId: string): number {
	const row = db.prepare("select coalesce(max(seq), -1) as m from msg where session_id = ?").get(sessionId) as
		| { m: number }
		| undefined;
	return Number(row?.m ?? -1);
}

export function getSession(db: DatabaseSync, id: string): SessionMeta | undefined {
	return resolveSession(db, id)?.meta;
}

/**
 * 接受完整 id 或任意前缀（列表里只展示 8 位，模型会拿短 id 回来读）。
 * 命中多个时返回歧义信息，而不是默默选一个。
 */
export function resolveSession(
	db: DatabaseSync,
	idOrPrefix: string,
): { meta: SessionMeta; exact: boolean } | { ambiguous: string[] } | undefined {
	const input = (idOrPrefix ?? "").trim();
	if (!input) return undefined;

	const row = db.prepare("select * from session where id = ?").get(input) as Record<string, any> | undefined;
	if (row) return { meta: toSessionMeta(row), exact: true };

	const rows = db
		.prepare("select * from session where id like ? order by last_at desc limit 10")
		.all(`${input}%`) as Array<Record<string, any>>;
	if (rows.length === 1) return { meta: toSessionMeta(rows[0]), exact: false };
	if (rows.length > 1) return { ambiguous: rows.map((r) => String(r.id)) };
	return undefined;
}

function toSessionMeta(row: Record<string, any>): SessionMeta {
	return {
		id: row.id,
		cwd: row.cwd,
		project: row.project,
		startedAt: row.started_at,
		lastAt: row.last_at,
		name: row.name ?? null,
	};
}

export function getMessage(db: DatabaseSync, id: number): MsgRow | undefined {
	return db.prepare("select id, session_id, seq, ts, role, text from msg where id = ?").get(id) as MsgRow | undefined;
}

export function readWindow(
	db: DatabaseSync,
	sessionId: string,
	fromSeq: number,
	toSeq: number,
): MsgRow[] {
	return db
		.prepare(
			"select id, session_id, seq, ts, role, text from msg where session_id = ? and seq between ? and ? order by seq",
		)
		.all(sessionId, fromSeq, toSeq) as MsgRow[];
}

export interface Stats {
	messages: number;
	sessions: number;
	bytes: number;
	oldest: number | null;
	newest: number | null;
}

export function stats(db: DatabaseSync, file: string): Stats {
	const m = db.prepare("select count(*) as c from msg").get() as { c: number };
	const s = db.prepare("select count(*) as c from session").get() as { c: number };
	const r = db.prepare("select min(ts) as a, max(ts) as b from msg").get() as { a: number | null; b: number | null };
	let bytes = 0;
	for (const suffix of ["", "-wal"]) {
		try {
			bytes += fs.statSync(file + suffix).size;
		} catch {
			// 没有 wal 文件是正常的
		}
	}
	return {
		messages: Number(m.c),
		sessions: Number(s.c),
		bytes,
		oldest: r?.a == null ? null : Number(r.a),
		newest: r?.b == null ? null : Number(r.b),
	};
}

/** cwd → 项目名（basename，小写）。 */
export function projectOf(cwd: string): string {
	const normalized = cwd.replace(/[\\/]+$/, "");
	const base = normalized.split(/[\\/]/).pop();
	return (base || normalized).toLowerCase();
}

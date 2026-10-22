/**
 * 能力检测：确认当前 Node 的内置 SQLite 具备本扩展依赖的两项能力。
 * 在 CI 里跑一遍，比等用户报 "no such option: contentless_delete" 好。
 */

import { DatabaseSync } from "node:sqlite";

function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`OK    ${name}`);
	} catch (error) {
		console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

check(`node:sqlite loads (node ${process.version})`, () => {
	const db = new DatabaseSync(":memory:");
	db.close();
});

check("FTS5 is available", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("create virtual table t using fts5(x)");
	db.exec("insert into t(x) values ('hello 世界')");
	const rows = db.prepare("select count(*) as c from t where t match ?").get('"hello"') as { c: number };
	if (Number(rows.c) !== 1) throw new Error("FTS5 MATCH returned no rows");
	db.close();
});

check("FTS5 contentless_delete is available (SQLite >= 3.43)", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("create virtual table t using fts5(x, content='', contentless_delete=1)");
	db.exec("insert into t(rowid, x) values (1, 'a b')");
	db.exec("delete from t where rowid = 1");
	const rows = db.prepare("select count(*) as c from t").get() as { c: number };
	if (Number(rows.c) !== 0) throw new Error("delete on contentless table did not take effect");
	db.close();
});

check("WAL journal mode", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("pragma journal_mode = WAL");
	db.close();
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestD1, type TestD1Database } from "../test-utils/sqlite-d1";
import { ReminderRepo } from "./reminders";

const NOW = "2026-10-03T08:00:00+09:00";

let db: TestD1Database;
let repo: ReminderRepo;

beforeEach(() => {
	db = createTestD1();
	repo = new ReminderRepo(db);
});

afterEach(() => {
	db.close();
});

/** 直接 SQL を投げてテスト用の行を作る（リポジトリの API では作れない状態のため）。 */
async function seed(row: {
	id: string;
	body: string;
	showAt: string;
	dueAt?: string | null;
	note?: string | null;
	kind?: "explicit" | "auto";
	archivedAt?: string | null;
	deletedAt?: string | null;
}): Promise<void> {
	await db
		.prepare(
			`INSERT INTO reminders
			 (id, body, show_at, due_at, note, kind, created_at, updated_at, archived_at, deleted_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.body,
			row.showAt,
			row.dueAt ?? null,
			row.note ?? null,
			row.kind ?? "explicit",
			NOW,
			NOW,
			row.archivedAt ?? null,
			row.deletedAt ?? null,
		)
		.run();
}

describe("takeBoard", () => {
	it("表示時刻が now ちょうどの行は取得し、now の 1 分後の行は取得しない", async () => {
		await seed({ id: "due-now", body: "ちょうど", showAt: NOW });
		await seed({ id: "one-minute-later", body: "1 分後", showAt: "2026-10-03T08:01:00+09:00" });

		const taken = await repo.takeBoard(NOW, 100);

		expect(taken.map((item) => item.id)).toEqual(["due-now"]);
		expect((await repo.listWaiting(NOW, 100)).map((r) => r.id)).toEqual(["one-minute-later"]);
	});

	it("表示に必要な列を camelCase で返す", async () => {
		await seed({
			id: "r1",
			body: "歯医者の予約",
			showAt: NOW,
			dueAt: "2026-10-05T23:59:00+09:00",
			note: "会話メモ",
			kind: "auto",
		});

		expect(await repo.takeBoard(NOW, 100)).toEqual([
			{
				id: "r1",
				body: "歯医者の予約",
				showAt: NOW,
				dueAt: "2026-10-05T23:59:00+09:00",
				kind: "auto",
			},
		]);
	});

	it("2 回目は 0 件で、1 回目に返った行の archivedAt が now になっている", async () => {
		await seed({ id: "a", body: "A", showAt: "2026-10-01T09:00:00+09:00" });
		await seed({ id: "b", body: "B", showAt: NOW });

		const first = await repo.takeBoard(NOW, 100);
		expect(first.map((item) => item.id).sort()).toEqual(["a", "b"]);

		expect(await repo.takeBoard(NOW, 100)).toEqual([]);

		const archived = await repo.listArchived(10);
		expect(archived.map((r) => r.id).sort()).toEqual(["a", "b"]);
		for (const row of archived) {
			expect(row.archivedAt).toBe(NOW);
		}
	});

	it("SQL 1 文（UPDATE … RETURNING）だけを発行し、事前に SELECT しない", async () => {
		const executed: string[] = [];
		const spy = {
			prepare(sql: string) {
				executed.push(sql);
				return db.prepare(sql);
			},
		} as unknown as D1Database;

		await seed({ id: "a", body: "A", showAt: NOW });
		executed.length = 0;

		await new ReminderRepo(spy).takeBoard(NOW, 100);

		// 「事前 SELECT 禁止」は別文を発行しないこと。件数を絞る副問い合わせは同じ 1 文の中。
		expect(executed).toHaveLength(1);
		expect(executed[0].trimStart().startsWith("UPDATE reminders SET archived_at")).toBe(true);
		expect(executed[0]).toContain("RETURNING");
	});

	it("limit を超えた分は表示時刻の古い順に残し、次の takeBoard で返す", async () => {
		await seed({ id: "c", body: "C", showAt: "2026-10-03T07:00:00+09:00" });
		await seed({ id: "a", body: "A", showAt: "2026-10-01T09:00:00+09:00" });
		await seed({ id: "b", body: "B", showAt: "2026-10-02T09:00:00+09:00" });

		expect((await repo.takeBoard(NOW, 2)).map((item) => item.id)).toEqual(["a", "b"]);
		expect((await repo.takeBoard(NOW, 2)).map((item) => item.id)).toEqual(["c"]);
		expect(await repo.takeBoard(NOW, 2)).toEqual([]);
	});

	it("削除済み・アーカイブ済みの行は取得しない", async () => {
		await seed({ id: "deleted", body: "削除済み", showAt: NOW, deletedAt: NOW });
		await seed({ id: "archived", body: "取得済み", showAt: NOW, archivedAt: NOW });

		expect(await repo.takeBoard(NOW, 100)).toEqual([]);
	});
});

describe("listWaiting / listActive", () => {
	it("削除済み・アーカイブ済みの行は出ず、待機中は表示時刻順になる", async () => {
		await seed({ id: "later", body: "後", showAt: "2026-10-05T09:00:00+09:00" });
		await seed({ id: "sooner", body: "先", showAt: "2026-10-04T09:00:00+09:00" });
		await seed({ id: "past", body: "過去", showAt: "2026-10-01T09:00:00+09:00" });
		await seed({
			id: "deleted",
			body: "削除済み",
			showAt: "2026-10-04T10:00:00+09:00",
			deletedAt: NOW,
		});
		await seed({
			id: "archived",
			body: "取得済み",
			showAt: "2026-10-04T11:00:00+09:00",
			archivedAt: NOW,
		});

		expect((await repo.listWaiting(NOW, 100)).map((r) => r.id)).toEqual(["sooner", "later"]);
		expect((await repo.listActive(100)).map((r) => r.id)).toEqual(["past", "sooner", "later"]);
	});

	it("listWaiting / listActive も limit を守る", async () => {
		await seed({ id: "past", body: "表示済み", showAt: "2026-10-01T09:00:00+09:00" });
		await seed({ id: "sooner", body: "近い", showAt: "2026-10-04T09:00:00+09:00" });
		await seed({ id: "later", body: "遠い", showAt: "2026-10-05T09:00:00+09:00" });

		expect((await repo.listWaiting(NOW, 1)).map((r) => r.id)).toEqual(["sooner"]);
		expect((await repo.listActive(2)).map((r) => r.id)).toEqual(["past", "sooner"]);
	});
});

describe("update / softDelete", () => {
	it("削除済み・アーカイブ済み・存在しない id には効かない", async () => {
		await seed({ id: "deleted", body: "削除済み", showAt: NOW, deletedAt: NOW });
		await seed({ id: "archived", body: "取得済み", showAt: NOW, archivedAt: NOW });

		for (const id of ["deleted", "archived", "missing"]) {
			expect(await repo.update(id, { body: "新しい本文" }, NOW)).toBeNull();
			expect(await repo.softDelete(id, NOW)).toBe(false);
		}
	});

	it("本文・期限・メモを更新し、null で期限とメモを消せる", async () => {
		const created = await repo.insert(
			{ body: "元の本文", dueAt: "2026-10-05T23:59:00+09:00", note: "メモ", kind: "explicit" },
			NOW,
		);
		const later = "2026-10-03T09:00:00+09:00";

		const renamed = await repo.update(created.id, { body: "新しい本文" }, later);
		expect(renamed).not.toBeNull();
		expect(renamed?.body).toBe("新しい本文");
		expect(renamed?.dueAt).toBe("2026-10-05T23:59:00+09:00");
		expect(renamed?.note).toBe("メモ");
		expect(renamed?.updatedAt).toBe(later);
		expect(renamed?.createdAt).toBe(NOW);

		const cleared = await repo.update(created.id, { dueAt: null, note: null }, later);
		expect(cleared?.dueAt).toBeNull();
		expect(cleared?.note).toBeNull();
	});

	it("値が undefined のキーは現状維持（消去しない）", async () => {
		const created = await repo.insert(
			{ body: "元の本文", dueAt: "2026-10-05T23:59:00+09:00", note: "メモ", kind: "explicit" },
			NOW,
		);
		const later = "2026-10-03T09:00:00+09:00";

		const kept = await repo.update(
			created.id,
			{ body: "新しい本文", dueAt: undefined, note: undefined },
			later,
		);

		expect(kept?.dueAt).toBe("2026-10-05T23:59:00+09:00");
		expect(kept?.note).toBe("メモ");
	});

	it("表示時刻を now より前に動かそうとすると now になる", async () => {
		const created = await repo.insert({ body: "本文", kind: "explicit" }, NOW);
		const later = "2026-10-03T09:00:00+09:00";

		const moved = await repo.update(created.id, { showAt: "2026-10-01T00:00:00+09:00" }, later);
		expect(moved?.showAt).toBe(later);

		const future = await repo.update(created.id, { showAt: "2026-10-09T07:00:00+09:00" }, later);
		expect(future?.showAt).toBe("2026-10-09T07:00:00+09:00");
	});

	it("softDelete した行はどの一覧にも出ず、updated_at が進む", async () => {
		const created = await repo.insert({ body: "本文", kind: "explicit" }, NOW);
		const later = "2026-10-03T09:00:00+09:00";

		expect(await repo.softDelete(created.id, later)).toBe(true);
		const row = await db
			.prepare("SELECT updated_at, deleted_at FROM reminders WHERE id = ?")
			.bind(created.id)
			.first<{ updated_at: string; deleted_at: string }>();
		expect(row).toEqual({ updated_at: later, deleted_at: later });
		expect(await repo.softDelete(created.id, NOW)).toBe(false);
		expect(await repo.takeBoard(NOW, 100)).toEqual([]);
		expect(await repo.listActive(100)).toEqual([]);
	});
});

describe("insert", () => {
	it("過去の showAt と省略時の showAt はどちらも now になる", async () => {
		const past = await repo.insert(
			{ body: "過去指定", showAt: "2026-09-30T12:00:00+09:00", kind: "explicit" },
			NOW,
		);
		const omitted = await repo.insert({ body: "省略", kind: "auto" }, NOW);

		expect(past.showAt).toBe(NOW);
		expect(omitted.showAt).toBe(NOW);
	});

	it("未来の showAt はそのまま保存し、既定値と登録日時を埋める", async () => {
		const row = await repo.insert(
			{ body: "本文", showAt: "2026-10-09T07:00:00+09:00", kind: "explicit" },
			NOW,
		);

		expect(row.showAt).toBe("2026-10-09T07:00:00+09:00");
		expect(row.dueAt).toBeNull();
		expect(row.note).toBeNull();
		expect(row.kind).toBe("explicit");
		expect(row.createdAt).toBe(NOW);
		expect(row.updatedAt).toBe(NOW);
		expect(row.archivedAt).toBeNull();
		expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("listArchived", () => {
	it("取得日時の新しい順で limit を守る", async () => {
		await seed({ id: "old", body: "古い", showAt: NOW, archivedAt: "2026-10-01T09:00:00+09:00" });
		await seed({ id: "mid", body: "中", showAt: NOW, archivedAt: "2026-10-02T09:00:00+09:00" });
		await seed({ id: "new", body: "新しい", showAt: NOW, archivedAt: "2026-10-03T09:00:00+09:00" });
		await seed({
			id: "deleted",
			body: "削除済み",
			showAt: NOW,
			archivedAt: "2026-10-03T10:00:00+09:00",
			deletedAt: NOW,
		});

		expect((await repo.listArchived(10)).map((r) => r.id)).toEqual(["new", "mid", "old"]);
		expect((await repo.listArchived(2)).map((r) => r.id)).toEqual(["new", "mid"]);
	});

	it("1 回の takeBoard で取った行（archived_at が同値）も順序が一意になる", async () => {
		await seed({ id: "b", body: "後に表示", showAt: "2026-10-03T07:00:00+09:00" });
		await seed({ id: "a", body: "先に表示", showAt: "2026-10-03T06:00:00+09:00" });
		await repo.takeBoard(NOW, 100);

		const ids = (await repo.listArchived(10)).map((r) => r.id);
		expect(ids).toEqual(["b", "a"]);
		expect((await repo.listArchived(1)).map((r) => r.id)).toEqual(["b"]);
	});
});

describe("recordCheck", () => {
	it("参照記録を 1 行ずつ追記する", async () => {
		await repo.recordCheck({ checkedAt: NOW, returnedCount: 0, ok: true, durationMs: 12 });
		await repo.recordCheck({
			checkedAt: NOW,
			returnedCount: 0,
			ok: false,
			errorCode: "DB_ERROR",
			durationMs: 34,
		});

		const { results } = await db
			.prepare("SELECT checked_at, returned_count, ok, error_code, duration_ms FROM board_checks ORDER BY id")
			.all();

		expect(results).toEqual([
			{ checked_at: NOW, returned_count: 0, ok: 1, error_code: null, duration_ms: 12 },
			{ checked_at: NOW, returned_count: 0, ok: 0, error_code: "DB_ERROR", duration_ms: 34 },
		]);
	});
});

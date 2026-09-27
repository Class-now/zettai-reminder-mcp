import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderRepo } from "../repo/reminders";
import { createTestD1, type TestD1Database } from "../test-utils/sqlite-d1";
import { ReminderService, ServiceError } from "./reminders";

/** 2026-10-03T08:00:00+09:00 に相当する epoch ミリ秒。 */
const NOW_MS = Date.UTC(2026, 9, 2, 23, 0, 0);
const NOW = "2026-10-03T08:00:00+09:00";

let db: TestD1Database;
let repo: ReminderRepo;
let nowMs: number;
let service: ReminderService;

beforeEach(() => {
	db = createTestD1();
	repo = new ReminderRepo(db);
	nowMs = NOW_MS;
	service = new ReminderService(repo, () => nowMs);
});

afterEach(() => {
	db.close();
});

async function countChecks(): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS c FROM board_checks").first<{ c: number }>();
	return Number(row?.c ?? 0);
}

async function latestCheck(): Promise<{
	checked_at: string;
	returned_count: number;
	ok: number;
	error_code: string | null;
	duration_ms: number;
}> {
	const row = await db
		.prepare(
			`SELECT checked_at, returned_count, ok, error_code, duration_ms
			 FROM board_checks ORDER BY id DESC LIMIT 1`,
		)
		.first<{
			checked_at: string;
			returned_count: number;
			ok: number;
			error_code: string | null;
			duration_ms: number;
		}>();
	if (row === null) {
		throw new Error("board_checks が空です");
	}
	return row;
}

describe("checkBoard", () => {
	it("期限の近い順・期限なしは後ろに並べて返す", async () => {
		await service.addReminder({ body: "10/5 期限", kind: "explicit", due_at: "2026-10-05" });
		await service.addReminder({ body: "10/3 期限", kind: "explicit", due_at: "2026-10-03" });
		await service.addReminder({ body: "期限なし", kind: "auto" });

		const result = await service.checkBoard();

		expect(result.count).toBe(3);
		expect(result.items.map((item) => item.body)).toEqual(["10/3 期限", "10/5 期限", "期限なし"]);
	});

	it("同じ期限（や期限なし同士）は表示時刻の昇順になる", async () => {
		nowMs = NOW_MS - 60_000;
		await service.addReminder({ body: "先に表示", kind: "explicit", due_at: "2026-10-05" });
		await service.addReminder({ body: "先に表示（期限なし）", kind: "explicit" });
		nowMs = NOW_MS;
		await service.addReminder({ body: "後に表示", kind: "explicit", due_at: "2026-10-05" });
		await service.addReminder({ body: "後に表示（期限なし）", kind: "explicit" });

		const result = await service.checkBoard();

		expect(result.items.map((item) => item.body)).toEqual([
			"先に表示",
			"後に表示",
			"先に表示（期限なし）",
			"後に表示（期限なし）",
		]);
	});

	it("期限ありの line に残り日数を入れ、会話メモは返さない", async () => {
		await service.addReminder({
			body: "住民税を払う",
			kind: "explicit",
			due_at: "2026-10-05",
			note: "コンビニで払う",
		});

		const result = await service.checkBoard();
		const item = result.items[0];

		expect(item.line).toBe("・住民税を払う（期限 10/5、あと 2 日）");
		expect(item.days_left).toBe(2);
		expect(item.due_at).toBe("2026-10-05T23:59:00+09:00");
		expect(Object.keys(item)).toEqual([
			"id",
			"body",
			"due_at",
			"days_left",
			"show_at",
			"kind",
			"line",
		]);
		expect(JSON.stringify(result)).not.toContain("コンビニ");
	});

	it("当日・超過・期限なしの line の形", async () => {
		await service.addReminder({ body: "今日まで", kind: "explicit", due_at: "2026-10-03" });
		await service.addReminder({ body: "超過", kind: "explicit", due_at: "2026-10-01" });
		await service.addReminder({ body: "期限なし", kind: "explicit" });

		const lines = (await service.checkBoard()).items.map((item) => item.line);

		expect(lines).toEqual([
			"・超過（期限 10/1、2 日超過）",
			"・今日まで（期限 10/3、今日まで）",
			"・期限なし",
		]);
	});

	it("0 件なら count 0・items 空で、参照記録が 1 件増える", async () => {
		const result = await service.checkBoard();

		expect(result).toEqual({ count: 0, items: [] });
		expect(JSON.stringify(result)).toBe('{"count":0,"items":[]}');
		expect(await countChecks()).toBe(1);
		expect(await latestCheck()).toMatchObject({
			checked_at: NOW,
			returned_count: 0,
			ok: 1,
			error_code: null,
		});
	});

	it("duration_ms に経過ミリ秒を記録する", async () => {
		// clock は checkBoard 内で 2 回読まれる（開始と記録時）。2 回目を 42ms 後にする。
		let reads = 0;
		service = new ReminderService(repo, () => {
			reads += 1;
			return reads === 1 ? NOW_MS : NOW_MS + 42;
		});

		await service.checkBoard();

		const check = await latestCheck();
		expect(check.duration_ms).toBe(42);
		expect(check.checked_at).toBe(NOW);
	});

	it("時計が巻き戻っても duration_ms は 0 以上になる", async () => {
		let reads = 0;
		service = new ReminderService(repo, () => {
			reads += 1;
			return reads === 1 ? NOW_MS : NOW_MS - 5_000;
		});

		await service.checkBoard();

		expect((await latestCheck()).duration_ms).toBe(0);
	});

	it("3 回呼ぶと参照記録が 3 行増え、同じリマインダーは 1 回しか返らない", async () => {
		await service.addReminder({ body: "一度だけ", kind: "explicit" });

		const first = await service.checkBoard();
		const second = await service.checkBoard();
		const third = await service.checkBoard();

		expect(first.count).toBe(1);
		expect(second.count).toBe(0);
		expect(third.count).toBe(0);
		expect(await countChecks()).toBe(3);
	});

	it("参照記録が失敗しても取得結果を返す", async () => {
		await service.addReminder({ body: "記録失敗でも返る", kind: "explicit" });
		const recordCheck = vi
			.spyOn(repo, "recordCheck")
			.mockRejectedValue(new Error("board_checks が壊れている"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await service.checkBoard();

		expect(result.items.map((item) => item.body)).toEqual(["記録失敗でも返る"]);
		expect(recordCheck).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalled();

		recordCheck.mockRestore();
		consoleError.mockRestore();
	});

	it("takeBoard が失敗したら DB_ERROR を投げ、失敗を記録する", async () => {
		const takeBoard = vi.spyOn(repo, "takeBoard").mockRejectedValue(new Error("D1 が落ちた"));

		await expect(service.checkBoard()).rejects.toMatchObject({ code: "DB_ERROR" });
		expect(await latestCheck()).toMatchObject({
			returned_count: 0,
			ok: 0,
			error_code: "DB_ERROR",
		});

		takeBoard.mockRestore();
	});
});

describe("addReminder", () => {
	it("期限の有無で confirmation が 2 形式になる", async () => {
		const withDue = await service.addReminder({
			body: "歯医者に行く",
			kind: "explicit",
			show_at: "2026-10-04T09:00:00+09:00",
			due_at: "2026-10-05",
		});
		const withoutDue = await service.addReminder({
			body: "本を返す",
			kind: "explicit",
			show_at: "2026-10-04T09:00:00+09:00",
		});

		expect(withDue.confirmation).toBe("登録しました：歯医者に行く（表示 10/4 09:00、期限 10/5）");
		expect(withoutDue.confirmation).toBe("登録しました：本を返す（表示 10/4 09:00）");
	});

	it("show_at の省略と過去指定はどちらも登録時刻になる", async () => {
		const omitted = await service.addReminder({ body: "省略", kind: "explicit" });
		const past = await service.addReminder({
			body: "過去",
			kind: "explicit",
			show_at: "2026-09-01T10:00:00+09:00",
		});

		expect(omitted.reminder.show_at).toBe(NOW);
		expect(past.reminder.show_at).toBe(NOW);
	});

	it("kind を保存し、note は応答に含むが check_board には出さない", async () => {
		const auto = await service.addReminder({ body: "自動登録", kind: "auto", note: "会話から" });

		expect(auto.reminder.kind).toBe("auto");
		expect(auto.reminder.note).toBe("会話から");

		const active = await service.listReminders({ status: "active" });
		expect(active.items[0].kind).toBe("auto");
	});

	it("オフセット無しの show_at は INVALID_DATETIME、空の body は VALIDATION_ERROR", async () => {
		await expect(
			service.addReminder({ body: "本文", kind: "explicit", show_at: "2026-10-04T09:00:00" }),
		).rejects.toMatchObject({ code: "INVALID_DATETIME" });
		await expect(service.addReminder({ body: "   ", kind: "explicit" })).rejects.toMatchObject({
			code: "VALIDATION_ERROR",
		});
	});
});

describe("listReminders", () => {
	beforeEach(async () => {
		await service.addReminder({ body: "取得できる", kind: "explicit" });
		await service.addReminder({
			body: "待機中",
			kind: "explicit",
			show_at: "2026-10-04T09:00:00+09:00",
		});
	});

	it("3 つのステータスが正しい集合を返す", async () => {
		expect((await service.listReminders({ status: "waiting" })).items.map((i) => i.body)).toEqual([
			"待機中",
		]);
		expect((await service.listReminders({ status: "active" })).items.map((i) => i.body)).toEqual([
			"取得できる",
			"待機中",
		]);
		expect((await service.listReminders({ status: "archived" })).count).toBe(0);

		await service.checkBoard();

		const archived = await service.listReminders({ status: "archived" });
		expect(archived.items.map((i) => i.body)).toEqual(["取得できる"]);
		expect(archived.items[0].archived_at).toBe(NOW);
		expect((await service.listReminders({ status: "active" })).items.map((i) => i.body)).toEqual([
			"待機中",
		]);
	});

	it("呼んでも行の状態は変わらない", async () => {
		await service.listReminders({ status: "waiting" });
		await service.listReminders({ status: "active" });
		await service.listReminders({ status: "archived" });

		const board = await service.checkBoard();
		expect(board.items.map((i) => i.body)).toEqual(["取得できる"]);
	});

	it("limit は waiting / active でも効く", async () => {
		expect((await service.listReminders({ status: "active", limit: 1 })).items.map((i) => i.body)).toEqual([
			"取得できる",
		]);
		expect((await service.listReminders({ status: "active" })).count).toBe(2);
		expect((await service.listReminders({ status: "waiting", limit: 1 })).count).toBe(1);
	});

	it("limit の境界（1 と 100）は通る", async () => {
		expect((await service.listReminders({ status: "archived", limit: 1 })).count).toBe(0);
		expect((await service.listReminders({ status: "archived", limit: 100 })).count).toBe(0);
	});

	it("archived の limit は範囲外なら VALIDATION_ERROR", async () => {
		await expect(
			service.listReminders({ status: "archived", limit: 0 }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
		await expect(
			service.listReminders({ status: "archived", limit: 101 }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
	});
});

describe("updateReminder", () => {
	it("表示時刻を未来に動かすと、その時刻より前の check_board には出ない", async () => {
		const added = await service.addReminder({ body: "後で", kind: "explicit" });

		const updated = await service.updateReminder({
			id: added.reminder.id,
			show_at: "2026-10-04T09:00:00+09:00",
			due_at: "2026-10-05",
		});

		expect(updated.confirmation).toBe("更新しました：後で（表示 10/4 09:00、期限 10/5）");
		expect((await service.checkBoard()).count).toBe(0);

		nowMs = Date.UTC(2026, 9, 4, 0, 0, 0); // 2026-10-04T09:00:00+09:00
		expect((await service.checkBoard()).items.map((i) => i.body)).toEqual(["後で"]);
	});

	it("due_at と note に null を渡すと消える", async () => {
		const added = await service.addReminder({
			body: "期限つき",
			kind: "explicit",
			show_at: "2026-10-04T09:00:00+09:00",
			due_at: "2026-10-05",
			note: "メモ",
		});

		const updated = await service.updateReminder({
			id: added.reminder.id,
			due_at: null,
			note: null,
		});

		expect(updated.reminder.due_at).toBeNull();
		expect(updated.reminder.note).toBeNull();
		expect(updated.confirmation).toBe("更新しました：期限つき（表示 10/4 09:00）");
	});

	it("存在しない id・アーカイブ済み id は NOT_FOUND", async () => {
		await expect(
			service.updateReminder({ id: "missing", body: "無い" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const added = await service.addReminder({ body: "取得済みになる", kind: "explicit" });
		await service.checkBoard();

		await expect(
			service.updateReminder({ id: added.reminder.id, body: "もう直せない" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("更新項目が 1 つも無ければ VALIDATION_ERROR", async () => {
		const added = await service.addReminder({ body: "何も変えない", kind: "explicit" });

		await expect(service.updateReminder({ id: added.reminder.id })).rejects.toMatchObject({
			code: "VALIDATION_ERROR",
		});
	});
});

describe("deleteReminder", () => {
	it("削除後は check_board・waiting・active に出ない", async () => {
		const shown = await service.addReminder({ body: "消す（表示済み）", kind: "explicit" });
		const waiting = await service.addReminder({
			body: "消す（待機中）",
			kind: "explicit",
			show_at: "2026-10-04T09:00:00+09:00",
		});

		expect(await service.deleteReminder(shown.reminder.id)).toEqual({
			deleted: shown.reminder.id,
		});
		expect(await service.deleteReminder(waiting.reminder.id)).toEqual({
			deleted: waiting.reminder.id,
		});

		expect((await service.checkBoard()).count).toBe(0);
		expect((await service.listReminders({ status: "waiting" })).count).toBe(0);
		expect((await service.listReminders({ status: "active" })).count).toBe(0);
	});

	it("存在しない id は NOT_FOUND", async () => {
		await expect(service.deleteReminder("missing")).rejects.toBeInstanceOf(ServiceError);
		await expect(service.deleteReminder("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

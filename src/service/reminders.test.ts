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

	it("1 回で返すのは 50 件までで、残りは次の呼び出しで返る", async () => {
		for (let i = 0; i < 52; i += 1) {
			await service.addReminder({ body: `項目 ${i}`, kind: "auto" });
		}

		const first = await service.checkBoard();
		expect(first.count).toBe(50);
		expect(first.items).toHaveLength(50);

		const second = await service.checkBoard();
		expect(second.count).toBe(2);

		expect((await service.checkBoard()).count).toBe(0);
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

describe("checkBoard の上限と並びの安定性", () => {
	it("期限も表示時刻も同じなら id 昇順で並ぶ（RETURNING の行順に依存しない）", async () => {
		const a = await service.addReminder({ body: "同着 A", kind: "auto", due_at: "2026-10-05" });
		const b = await service.addReminder({ body: "同着 B", kind: "auto", due_at: "2026-10-05" });
		const c = await service.addReminder({ body: "同着 C", kind: "auto", due_at: "2026-10-05" });

		const expected = [a.reminder, b.reminder, c.reminder]
			.map((r) => ({ id: r.id, body: r.body }))
			.sort((x, y) => (x.id < y.id ? -1 : 1))
			.map((r) => r.body);

		const board = await service.checkBoard();
		expect(board.items.map((i) => i.show_at)).toEqual([NOW, NOW, NOW]);
		expect(board.items.map((i) => i.due_at)).toEqual([
			"2026-10-05T23:59:00+09:00",
			"2026-10-05T23:59:00+09:00",
			"2026-10-05T23:59:00+09:00",
		]);
		expect(board.items.map((i) => i.body)).toEqual(expected);
	});

	it("50 件で打ち切ったら has_more が付き、残りは次の呼び出しで返る", async () => {
		for (let i = 0; i < 51; i += 1) {
			await service.addReminder({ body: `件 ${i}`, kind: "auto" });
		}

		const first = await service.checkBoard();
		expect(first.count).toBe(50);
		expect(first.has_more).toBe(true);

		const second = await service.checkBoard();
		expect(second.count).toBe(1);
		expect(second.has_more).toBeUndefined();
	});

	it("上限に届かなければ has_more は付かず、0 件の JSON の形も変わらない", async () => {
		expect(JSON.stringify(await service.checkBoard())).toBe('{"count":0,"items":[]}');

		await service.addReminder({ body: "1 件だけ", kind: "auto" });
		const board = await service.checkBoard();
		expect(board.has_more).toBeUndefined();
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

	it("show_at / due_at / note の null は省略と同じに扱う", async () => {
		const added = await service.addReminder({
			body: "null 入り",
			kind: "auto",
			show_at: null,
			due_at: null,
			note: null,
		});

		expect(added.reminder.show_at).toBe(NOW);
		expect(added.reminder.due_at).toBeNull();
		expect(added.reminder.note).toBeNull();
		expect(added.confirmation).toBe("登録しました：null 入り（表示 10/3 08:00）");
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

	it("body は前後を落として 1 行に畳む（line と confirmation が複数行にならない）", async () => {
		const added = await service.addReminder({ body: "  ゴミを\n出す  ", kind: "explicit" });

		expect(added.reminder.body).toBe("ゴミを 出す");
		expect(added.confirmation).toBe("登録しました：ゴミを 出す（表示 10/3 08:00）");
		expect(added.confirmation).not.toContain("\n");

		const board = await service.checkBoard();
		expect(board.items[0].line).toBe("・ゴミを 出す");
		expect(board.items[0].line).not.toContain("\n");
	});

	it("単独の全角スペースは残し、連続する空白だけを半角 1 個に畳む", async () => {
		const kept = await service.addReminder({ body: "山田\u3000太郎に連絡", kind: "explicit" });
		expect(kept.reminder.body).toBe("山田\u3000太郎に連絡");

		const folded = await service.addReminder({ body: "山田\u3000\u3000太郎に連絡", kind: "explicit" });
		expect(folded.reminder.body).toBe("山田 太郎に連絡");
	});

	it("body は 200 文字まで、201 文字は VALIDATION_ERROR", async () => {
		const ok = await service.addReminder({ body: "あ".repeat(200), kind: "explicit" });
		expect(ok.reminder.body.length).toBe(200);

		await expect(
			service.addReminder({ body: "あ".repeat(201), kind: "explicit" }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
	});

	it("上限は文字数で数える（サロゲートペアの絵文字を 2 文字と数えない）", async () => {
		// UTF-16 のコード単位で数えると 400 で弾かれてしまう 200 文字。
		const ok = await service.addReminder({ body: "\u{1f44d}".repeat(200), kind: "explicit" });
		expect([...ok.reminder.body].length).toBe(200);

		const over = await service
			.addReminder({ body: "\u{1f44d}".repeat(201), kind: "explicit" })
			.catch((cause: unknown) => cause);
		expect(over).toMatchObject({ code: "VALIDATION_ERROR" });
		expect((over as ServiceError).message).toContain("201 文字");

		const noteOk = await service.addReminder({
			body: "絵文字のメモ",
			kind: "auto",
			note: "\u{1f44d}".repeat(1000),
		});
		expect([...(noteOk.reminder.note ?? "")].length).toBe(1000);

		await expect(
			service.addReminder({ body: "絵文字のメモ", kind: "auto", note: "\u{1f44d}".repeat(1001) }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
	});

	it("note は空白だけなら null になり、1000 文字を超えると VALIDATION_ERROR", async () => {
		const blank = await service.addReminder({ body: "メモなし", kind: "auto", note: "   " });
		expect(blank.reminder.note).toBeNull();

		const trimmed = await service.addReminder({ body: "メモあり", kind: "auto", note: "  会話  " });
		expect(trimmed.reminder.note).toBe("会話");

		await expect(
			service.addReminder({ body: "長すぎ", kind: "auto", note: "あ".repeat(1001) }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
	});

	it("知らない kind は VALIDATION_ERROR（zod を通さず呼んでも弾く）", async () => {
		await expect(
			service.addReminder({ body: "本文", kind: "maybe" as never }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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

	it("archived の limit は実際に件数を絞り、既定（20）までは全件返す", async () => {
		await service.addReminder({ body: "取得できる 2", kind: "explicit" });
		await service.addReminder({ body: "取得できる 3", kind: "explicit" });
		await service.checkBoard();

		expect((await service.listReminders({ status: "archived", limit: 1 })).count).toBe(1);
		expect((await service.listReminders({ status: "archived", limit: 2 })).count).toBe(2);
		expect((await service.listReminders({ status: "archived" })).count).toBe(3);
	});

	it("limit で切り捨てたときだけ has_more が付く", async () => {
		const truncated = await service.listReminders({ status: "active", limit: 1 });
		expect(truncated.has_more).toBe(true);
		expect(truncated.count).toBe(1);

		const whole = await service.listReminders({ status: "active", limit: 2 });
		expect(whole.has_more).toBeUndefined();
		expect(whole.count).toBe(2);

		expect((await service.listReminders({ status: "waiting", limit: 1 })).has_more).toBeUndefined();
	});

	it("limit が整数でなければ VALIDATION_ERROR（zod を通さず呼んでも弾く）", async () => {
		await expect(service.listReminders({ status: "active", limit: 1.5 })).rejects.toMatchObject({
			code: "VALIDATION_ERROR",
		});
	});

	it("知らない status は VALIDATION_ERROR", async () => {
		await expect(
			service.listReminders({ status: "done" as never }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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

	it("空白だけの body は VALIDATION_ERROR、note の空文字は消去になる", async () => {
		const added = await service.addReminder({ body: "直す", kind: "explicit", note: "メモ" });

		await expect(
			service.updateReminder({ id: added.reminder.id, body: "   " }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

		const cleared = await service.updateReminder({ id: added.reminder.id, note: "" });
		expect(cleared.reminder.note).toBeNull();

		const collapsed = await service.updateReminder({ id: added.reminder.id, body: " 新\nしい " });
		expect(collapsed.reminder.body).toBe("新 しい");

		// show_at は消せない列なので null は「指定なし」。他の項目だけが変わる
		const withNullShowAt = await service.updateReminder({
			id: added.reminder.id,
			show_at: null,
			note: "残す",
		});
		expect(withNullShowAt.reminder.show_at).toBe(added.reminder.show_at);
		expect(withNullShowAt.reminder.note).toBe("残す");

		// null だけなら指定が無いのと同じで VALIDATION_ERROR
		await expect(
			service.updateReminder({ id: added.reminder.id, show_at: null }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

		await expect(
			service.updateReminder({ id: added.reminder.id, body: "あ".repeat(201) }),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReminderRepo } from "../repo/reminders";
import { createTestD1, type TestD1Database } from "../test-utils/sqlite-d1";
import { createReminderHandlers, registerReminderTools } from "./register";

/** 2026-10-03T08:00:00+09:00 に相当する epoch ミリ秒。 */
const NOW_MS = Date.UTC(2026, 9, 2, 23, 0, 0);

let db: TestD1Database;
let repo: ReminderRepo;
let handlers: ReturnType<typeof createReminderHandlers>;

beforeEach(() => {
	db = createTestD1();
	repo = new ReminderRepo(db);
	handlers = createReminderHandlers({ repo, clock: () => NOW_MS });
});

afterEach(() => {
	db.close();
});

/** registerTool に渡された設定をツール名で引く。 */
function registeredConfigs(): Map<string, { description?: string; inputSchema?: Record<string, z.ZodTypeAny> }> {
	const registerTool = vi.fn();
	registerReminderTools({ registerTool } as unknown as McpServer, { repo });
	return new Map(
		registerTool.mock.calls.map((call) => [
			call[0] as string,
			call[1] as { description?: string; inputSchema?: Record<string, z.ZodTypeAny> },
		]),
	);
}

function parse(result: { content: { text: string }[] }): unknown {
	return JSON.parse(result.content[0].text);
}

describe("registerReminderTools", () => {
	it("5 つのツールを説明文つきで登録する", () => {
		const registerTool = vi.fn();
		const server = { registerTool } as unknown as McpServer;

		registerReminderTools(server, { repo });

		const names = registerTool.mock.calls.map((call) => call[0]);
		expect(names).toEqual([
			"check_board",
			"add_reminder",
			"list_reminders",
			"update_reminder",
			"delete_reminder",
		]);
		for (const call of registerTool.mock.calls) {
			expect(typeof call[1].description).toBe("string");
			expect((call[1].description as string).length).toBeGreaterThan(0);
			expect(typeof call[2]).toBe("function");
		}
	});

	it("check_board 以外は入力スキーマを持ち、check_board は入力を取らない", () => {
		const registerTool = vi.fn();
		const server = { registerTool } as unknown as McpServer;

		registerReminderTools(server, { repo });

		const configs = new Map(
			registerTool.mock.calls.map((call) => [call[0] as string, call[1] as { inputSchema?: object }]),
		);
		expect(configs.get("check_board")?.inputSchema).toBeUndefined();
		expect(Object.keys(configs.get("add_reminder")?.inputSchema ?? {})).toEqual([
			"body",
			"kind",
			"show_at",
			"due_at",
			"note",
		]);
		expect(Object.keys(configs.get("list_reminders")?.inputSchema ?? {})).toEqual([
			"status",
			"limit",
		]);
		expect(Object.keys(configs.get("update_reminder")?.inputSchema ?? {})).toEqual([
			"id",
			"body",
			"show_at",
			"due_at",
			"note",
		]);
		expect(Object.keys(configs.get("delete_reminder")?.inputSchema ?? {})).toEqual(["id"]);
	});

	it("登録したコールバックがツール名どおりの処理につながっている", async () => {
		const registerTool = vi.fn();
		registerReminderTools({ registerTool } as unknown as McpServer, { repo, clock: () => NOW_MS });
		const callbacks = new Map(
			registerTool.mock.calls.map((call) => [
				call[0] as string,
				call[2] as (input: unknown) => Promise<{ content: { text: string }[] }>,
			]),
		);

		const added = parse(
			await callbacks.get("add_reminder")!({ body: "配線の確認", kind: "explicit" }),
		) as { reminder: { id: string } };
		expect(added.reminder.id).toBeTypeOf("string");

		expect(parse(await callbacks.get("list_reminders")!({ status: "active" }))).toMatchObject({
			status: "active",
			count: 1,
		});

		expect(
			parse(await callbacks.get("update_reminder")!({ id: added.reminder.id, body: "直した" })),
		).toMatchObject({ reminder: { body: "直した" } });

		// update が delete につながっていれば、この時点で行が消えていて NOT_FOUND になる
		expect(parse(await callbacks.get("delete_reminder")!({ id: added.reminder.id }))).toEqual({
			deleted: added.reminder.id,
		});

		expect(parse(await callbacks.get("check_board")!({}))).toEqual({ count: 0, items: [] });
	});

	it("check_board の説明文が呼ぶタイミングと書き方を伝えている", () => {
		const description = registeredConfigs().get("check_board")?.description as string;
		expect(description).toContain("最初の応答");
		expect(description).toContain("1 回だけ");
		expect(description).toContain("line");
		expect(description).toContain("0 件");
	});
});

describe("実物の McpServer への登録", () => {
	it("SDK の registerTool が 5 本の zod スキーマをそのまま受け取れる", async () => {
		// registerTool のシグネチャや zod の形が SDK 更新で壊れたら、モックでは気づけない
		const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
		const server = new McpServer({ name: "test", version: "0.0.0" });

		expect(() => registerReminderTools(server, { repo, clock: () => NOW_MS })).not.toThrow();
	});
});

describe("入力スキーマ（zod）", () => {
	function schemaOf(tool: string): z.ZodObject<Record<string, z.ZodTypeAny>> {
		const shape = registeredConfigs().get(tool)?.inputSchema;
		if (shape === undefined) {
			throw new Error(`${tool} に inputSchema がありません`);
		}
		return z.object(shape);
	}

	it("add_reminder は kind を explicit / auto に限り、body を必須にする", () => {
		const schema = schemaOf("add_reminder");

		expect(schema.safeParse({ body: "本文", kind: "explicit" }).success).toBe(true);
		expect(schema.safeParse({ body: "本文", kind: "maybe" }).success).toBe(false);
		expect(schema.safeParse({ kind: "auto" }).success).toBe(false);
		expect(schema.safeParse({ body: 1, kind: "auto" }).success).toBe(false);
	});

	it("add_reminder は show_at / due_at / note の null を省略と同じに受ける", () => {
		// update_reminder が null を消去の意味で受けるので、同じ値が add に来ても弾かない
		// （zod で落ちると共通の error 封筒に載らず、登録も黙って失敗する）
		const schema = schemaOf("add_reminder");

		expect(
			schema.safeParse({ body: "本文", kind: "auto", show_at: null, due_at: null, note: null })
				.success,
		).toBe(true);
	});

	it("update_reminder は body / show_at の null を指定なしと同じに受ける", () => {
		// body / show_at は消せない列だが、due_at / note と同じ形で null が来ても
		// zod で落として封筒外のエラーにしない
		const schema = schemaOf("update_reminder");

		expect(schema.safeParse({ id: "r1", show_at: null, note: "メモ" }).success).toBe(true);
		expect(schema.safeParse({ id: "r1", body: null, note: "メモ" }).success).toBe(true);
	});

	it("list_reminders は status を 3 値に限り、limit を 1〜100 の整数に限る", () => {
		const schema = schemaOf("list_reminders");

		expect(schema.safeParse({ status: "active" }).success).toBe(true);
		expect(schema.safeParse({ status: "archived", limit: 1 }).success).toBe(true);
		expect(schema.safeParse({ status: "archived", limit: 100 }).success).toBe(true);
		expect(schema.safeParse({ status: "archived", limit: 0 }).success).toBe(false);
		expect(schema.safeParse({ status: "archived", limit: 101 }).success).toBe(false);
		expect(schema.safeParse({ status: "archived", limit: 1.5 }).success).toBe(false);
		expect(schema.safeParse({ status: "done" }).success).toBe(false);
	});

	it("list_reminders は limit の null を省略と同じに受ける", () => {
		// 任意の項目に null が来ても zod で落とさない（封筒外のエラーにしない）
		expect(schemaOf("list_reminders").safeParse({ status: "active", limit: null }).success).toBe(
			true,
		);
	});

	it("update_reminder は due_at / note に null を許し、delete_reminder は id を必須にする", () => {
		expect(
			schemaOf("update_reminder").safeParse({ id: "x", due_at: null, note: null }).success,
		).toBe(true);
		expect(schemaOf("update_reminder").safeParse({ id: 1 }).success).toBe(false);
		expect(schemaOf("delete_reminder").safeParse({}).success).toBe(false);
	});
});

describe("check_board の応答", () => {
	it("0 件の text が正確に {\"count\":0,\"items\":[]} で、参照記録が 1 件増える", async () => {
		const result = await handlers.check_board();

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: '{"count":0,"items":[]}' }]);

		const row = await db
			.prepare("SELECT returned_count, ok FROM board_checks")
			.all<{ returned_count: number; ok: number }>();
		expect(row.results).toEqual([{ returned_count: 0, ok: 1 }]);
	});

	it("takeBoard が失敗したら isError で DB_ERROR を返す", async () => {
		const takeBoard = vi.spyOn(repo, "takeBoard").mockRejectedValue(new Error("D1 が落ちた"));

		const result = await handlers.check_board();

		expect(result.isError).toBe(true);
		expect(parse(result)).toMatchObject({ error: { code: "DB_ERROR" } });

		takeBoard.mockRestore();
	});
});

describe("入力の検証", () => {
	it("オフセット無しの show_at は INVALID_DATETIME", async () => {
		const result = await handlers.add_reminder({
			body: "本文",
			kind: "explicit",
			show_at: "2026-10-04T09:00:00",
		});

		expect(result.isError).toBe(true);
		expect(parse(result)).toMatchObject({ error: { code: "INVALID_DATETIME" } });
	});

	it("空の body は VALIDATION_ERROR", async () => {
		const result = await handlers.add_reminder({ body: "", kind: "explicit" });

		expect(result.isError).toBe(true);
		expect(parse(result)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
	});

	it("存在しない id の update・delete は NOT_FOUND", async () => {
		const updated = await handlers.update_reminder({ id: "missing", body: "無い" });
		const deleted = await handlers.delete_reminder({ id: "missing" });

		expect(parse(updated)).toMatchObject({ error: { code: "NOT_FOUND" } });
		expect(parse(deleted)).toMatchObject({ error: { code: "NOT_FOUND" } });
	});
});

describe("成功時の応答", () => {
	it("add_reminder は reminder と confirmation を JSON で返す", async () => {
		const result = await handlers.add_reminder({
			body: "ゴミを出す",
			kind: "auto",
			due_at: "2026-10-05",
		});

		expect(result.isError).toBeUndefined();
		expect(parse(result)).toMatchObject({
			reminder: { body: "ゴミを出す", kind: "auto", show_at: "2026-10-03T08:00:00+09:00" },
			confirmation: "登録しました：ゴミを出す（表示 10/3 08:00、期限 10/5）",
		});
	});

	it("list_reminders は status・count・items を返す", async () => {
		await handlers.add_reminder({ body: "一覧に出る", kind: "explicit" });

		const result = await handlers.list_reminders({ status: "active" });

		expect(parse(result)).toMatchObject({ status: "active", count: 1 });
	});

	it("delete_reminder は deleted に id を返す", async () => {
		const added = await handlers.add_reminder({ body: "消す", kind: "explicit" });
		const id = (parse(added) as { reminder: { id: string } }).reminder.id;

		const result = await handlers.delete_reminder({ id });

		expect(parse(result)).toEqual({ deleted: id });
	});
});

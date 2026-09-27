/**
 * MCP 登録層。入力スキーマ（zod）と応答形式の変換だけを持ち、処理そのものは
 * `ReminderService` に委ねる。
 *
 * 応答形式は全ツール共通:
 * - 成功: `{ content: [{ type: "text", text: JSON.stringify(result) }] }`
 * - 失敗: `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] }`
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DateTimeError } from "../lib/datetime";
import type { ReminderRepo } from "../repo/reminders";
import {
	type AddReminderInput,
	type ErrorCode,
	type ListRemindersInput,
	ReminderService,
	ServiceError,
	type UpdateReminderInput,
} from "../service/reminders";

/** MCP SDK の `CallToolResult` に代入できるよう、拡張用の索引シグネチャを持たせる。 */
export interface ToolResult {
	[key: string]: unknown;
	content: { type: "text"; text: string }[];
	isError?: true;
}

export interface ReminderToolDeps {
	repo: ReminderRepo;
	clock?: () => number;
}

function ok(result: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

function fail(code: ErrorCode, message: string): ToolResult {
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
	};
}

/** 例外をエラーコードに直す。想定外の失敗は D1 起因とみなす。 */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return ok(await fn());
	} catch (cause) {
		if (cause instanceof ServiceError) {
			return fail(cause.code, cause.message);
		}
		if (cause instanceof DateTimeError) {
			return fail(cause.code, cause.message);
		}
		console.error("ツールの実行に失敗しました", cause);
		return fail("DB_ERROR", "データベースの操作に失敗しました");
	}
}

const CHECK_BOARD_DESCRIPTION =
	"新しい会話の最初の応答を書く前に 1 回だけ呼ぶ。表示時刻を過ぎたリマインダーを 1 回 50 件まで返し、同時にアーカイブする（同じものは二度返らない。超えた分は残り、次の呼び出しで返る）。返された line を応答の 1 行目から順にそのまま書く。0 件なら何も書かない。has_more が true なら最後に「まだ表示していないリマインダーがあります」と 1 行書く。";

const ADD_REMINDER_DESCRIPTION =
	"リマインダーを登録する。頼まれたときは kind=\"explicit\"、会話から拾って自動登録するときは kind=\"auto\"。show_at を省略すると即時（次の check_board）で表示される。返り値の confirmation を同じ応答に 1 行そのまま書く。";

const LIST_REMINDERS_DESCRIPTION =
	"リマインダーを一覧する。waiting=表示時刻待ち、active=未取得の全件（重複登録の確認に使う）、archived=取得済みの見返し（新しい順）。行の状態は変わらない。has_more が true なら limit で切れた分があるので、重複の判断に使うときは一覧が全件でないことを前提にする。";

const UPDATE_REMINDER_DESCRIPTION =
	"既存のリマインダーの本文・表示時刻・期限・会話メモを直す。due_at と note に null を渡すと消去する。取得済み・削除済み・存在しない id は NOT_FOUND になる。";

const DELETE_REMINDER_DESCRIPTION =
	"リマインダーを取り消す（論理削除）。取得済み・削除済み・存在しない id は NOT_FOUND になる。";

const JST_HINT = "日本時間の YYYY-MM-DDTHH:MM:SS+09:00 形式";

const addShape = {
	body: z.string().describe("リマインダーの本文（1〜200 文字。改行は半角スペースに畳まれる）"),
	kind: z.enum(["explicit", "auto"]).describe("依頼による登録は explicit、自動登録は auto"),
	show_at: z.string().nullish().describe(`表示時刻（${JST_HINT}）。省略または null で即時`),
	due_at: z.string().nullish().describe(`期限（${JST_HINT} または YYYY-MM-DD）。省略または null で期限なし`),
	note: z
		.string()
		.nullish()
		.describe("会話メモ（1000 文字以内）。省略または null でメモなし。check_board の応答には含まれない"),
};

const listShape = {
	status: z.enum(["waiting", "active", "archived"]).describe("一覧する対象"),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("返す件数の上限（1〜100）。既定は archived が 20、waiting / active が 100"),
};

const updateShape = {
	id: z.string().describe("対象のリマインダー id"),
	body: z.string().optional().describe("新しい本文（1〜200 文字）"),
	show_at: z.string().optional().describe(`新しい表示時刻（${JST_HINT}）`),
	due_at: z.string().nullable().optional().describe(`新しい期限。null で期限を消す`),
	note: z.string().nullable().optional().describe("新しい会話メモ（1000 文字以内）。null で消す"),
};

const deleteShape = {
	id: z.string().describe("取り消すリマインダーの id"),
};

/** ツール名から処理を引ける形。MCP を通さずにテストできる。 */
export function createReminderHandlers(deps: ReminderToolDeps) {
	const service = new ReminderService(deps.repo, deps.clock);
	return {
		check_board: (): Promise<ToolResult> => run(() => service.checkBoard()),
		add_reminder: (input: AddReminderInput): Promise<ToolResult> =>
			run(() => service.addReminder(input)),
		list_reminders: (input: ListRemindersInput): Promise<ToolResult> =>
			run(() => service.listReminders(input)),
		update_reminder: (input: UpdateReminderInput): Promise<ToolResult> =>
			run(() => service.updateReminder(input)),
		delete_reminder: (input: { id: string }): Promise<ToolResult> =>
			run(() => service.deleteReminder(input.id)),
	};
}

export function registerReminderTools(server: McpServer, deps: ReminderToolDeps): void {
	const handlers = createReminderHandlers(deps);

	server.registerTool("check_board", { description: CHECK_BOARD_DESCRIPTION }, () =>
		handlers.check_board(),
	);

	server.registerTool(
		"add_reminder",
		{ description: ADD_REMINDER_DESCRIPTION, inputSchema: addShape },
		(input) => handlers.add_reminder(input as AddReminderInput),
	);

	server.registerTool(
		"list_reminders",
		{ description: LIST_REMINDERS_DESCRIPTION, inputSchema: listShape },
		(input) => handlers.list_reminders(input as ListRemindersInput),
	);

	server.registerTool(
		"update_reminder",
		{ description: UPDATE_REMINDER_DESCRIPTION, inputSchema: updateShape },
		(input) => handlers.update_reminder(input as UpdateReminderInput),
	);

	server.registerTool(
		"delete_reminder",
		{ description: DELETE_REMINDER_DESCRIPTION, inputSchema: deleteShape },
		(input) => handlers.delete_reminder(input as { id: string }),
	);
}

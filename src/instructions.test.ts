import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS } from "./instructions";

describe("SERVER_INSTRUCTIONS", () => {
	const lines = SERVER_INSTRUCTIONS.split("\n");

	it("8 行以内で、空行を含まない", () => {
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.every((line) => line.trim().length > 0)).toBe(true);
	});

	it("5 つのツールの使い方に触れている", () => {
		expect(SERVER_INSTRUCTIONS).toContain("check_board");
		expect(SERVER_INSTRUCTIONS).toContain('add_reminder(kind="explicit")');
		expect(SERVER_INSTRUCTIONS).toContain('add_reminder(kind="auto")');
		expect(SERVER_INSTRUCTIONS).toContain('list_reminders(status="active")');
		expect(SERVER_INSTRUCTIONS).toContain("update_reminder");
	});

	it("最初の応答前に 1 回だけ呼ぶこと・0 件なら書かないこと・失敗時の 1 行を伝えている", () => {
		expect(SERVER_INSTRUCTIONS).toContain("最初の応答");
		expect(SERVER_INSTRUCTIONS).toContain("1 回だけ");
		expect(SERVER_INSTRUCTIONS).toContain("0 件なら何も書かない");
		expect(SERVER_INSTRUCTIONS).toContain("リマインダーを確認できませんでした");
	});

	it("秘密値になりうる文字列を含まない", () => {
		expect(SERVER_INSTRUCTIONS).not.toMatch(/token|secret|client_id/i);
	});
});

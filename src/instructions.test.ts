import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS } from "./instructions";

/** README.md / SETUP.md 手順 8 に貼ってある「ユーザー設定に入れる指示文」を取り出す。 */
function userInstructionBlock(file: string): string {
	const path = fileURLToPath(new URL(`../${file}`, import.meta.url).href);
	const match = /```\n(【リマインダー】[\s\S]*?)```/.exec(readFileSync(path, "utf8"));
	if (match === null) {
		throw new Error(`${file} に【リマインダー】の指示文ブロックがありません`);
	}
	return match[1];
}

describe("SERVER_INSTRUCTIONS", () => {
	const lines = SERVER_INSTRUCTIONS.split("\n");

	it("8 行以内で、空行を含まない", () => {
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.every((line) => line.trim().length > 0)).toBe(true);
	});

	it("4 つのツールの使い方に触れている（delete_reminder は説明文だけで足りる）", () => {
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

/** 指示文は SERVER_INSTRUCTIONS / README.md / SETUP.md 手順 8 の 3 か所にあり、同時に直す決まり。 */
describe("ユーザー設定の指示文", () => {
	it("README.md と SETUP.md のブロックが一字一句同じ", () => {
		expect(userInstructionBlock("README.md")).toBe(userInstructionBlock("SETUP.md"));
	});

	it("SERVER_INSTRUCTIONS と同じ取り決めを指している", () => {
		const block = userInstructionBlock("README.md");
		for (const tool of [
			"check_board",
			'add_reminder(kind="explicit")',
			'add_reminder(kind="auto")',
			'list_reminders(status="active")',
			"update_reminder",
		]) {
			expect(block).toContain(tool);
		}
		expect(block).toContain("リマインダーを確認できませんでした");
	});
});

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type InitializeRequest, InitializeRequestSchema, type InitializeResult } from "@modelcontextprotocol/sdk/types.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/utils";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { ReminderRepo } from "./repo/reminders";
import { isChatCaller } from "./service/reminders";
import { callerOf, registerReminderTools } from "./tools/register";
import type { Env } from "./types";

/** SDK の `Server` が持つ既定の initialize 処理（非公開メソッド）。 */
type InitializeHandler = { _oninitialize(request: InitializeRequest): Promise<InitializeResult> };

export class ReminderMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer(
		{ name: "絶対伝えろよリマインダー", version: "0.1.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	async init() {
		registerReminderTools(this.server, {
			repo: new ReminderRepo(this.env.DB),
			clock: Date.now,
		});

		// 指示文は claude.ai のチャットにだけ渡す。Claude Code などでは接続のたびに
		// 指示文が文脈へ差し込まれ、新しい会話でもないのに check_board を呼ばせてしまう。
		const base = this.server.server as unknown as InitializeHandler;
		this.server.server.setRequestHandler(InitializeRequestSchema, async (request, extra) => {
			const result = await base._oninitialize(request);
			if (isChatCaller(callerOf(extra))) {
				return result;
			}
			const { instructions: _omitted, ...rest } = result;
			return rest;
		});
	}
}

const provider = new OAuthProvider({
	apiHandlers: { "/mcp": ReminderMCP.serve("/mcp") },
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as unknown as ExportedHandler,
	tokenEndpoint: "/token",
});

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;

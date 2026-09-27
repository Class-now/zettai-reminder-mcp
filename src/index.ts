import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./auth/github-handler";
import type { Props } from "./auth/utils";
import { SERVER_INSTRUCTIONS } from "./instructions";
import type { Env } from "./types";

export class ReminderMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer(
		{ name: "絶対伝えろよリマインダー", version: "0.1.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	async init() {
		// Task 4 で registerReminderTools(this.server, deps) を呼ぶ
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

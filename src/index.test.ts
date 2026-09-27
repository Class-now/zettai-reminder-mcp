import { beforeEach, describe, expect, it, vi } from "vitest";

// node 環境の vitest では agents/mcp・workers-oauth-provider・auth/github-handler が
// `cloudflare:` スキームの import を辿って読み込めないため、最小モックを挟む。
const providerFetch = vi.fn<(request: Request, env: unknown, ctx: unknown) => Promise<Response>>();
const oauthProviderOptions: unknown[] = [];
const serveHandler = { fetch: vi.fn() };
const serveCalls: string[] = [];

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	default: class OAuthProvider {
		fetch = providerFetch;
		constructor(options: unknown) {
			oauthProviderOptions.push(options);
		}
	},
}));

vi.mock("agents/mcp", () => ({
	McpAgent: class McpAgent {
		static serve(path: string) {
			serveCalls.push(path);
			return serveHandler;
		}
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class McpServer {
		constructor(
			public info: unknown,
			public options: unknown,
		) {}
	},
}));

vi.mock("./auth/github-handler", () => ({ GitHubHandler: {} }));

const worker = await import("./index");

type OAuthOptions = {
	apiHandlers: Record<string, unknown>;
	authorizeEndpoint: string;
	clientRegistrationEndpoint: string;
	tokenEndpoint: string;
	defaultHandler: unknown;
};

const options = oauthProviderOptions[0] as OAuthOptions;

describe("worker entry", () => {
	beforeEach(() => {
		providerFetch.mockReset();
	});

	it("ReminderMCP を export している", () => {
		expect(typeof worker.ReminderMCP).toBe("function");
	});

	it("/mcp を ReminderMCP.serve('/mcp') で登録している", () => {
		expect(serveCalls).toContain("/mcp");
		expect(options.apiHandlers["/mcp"]).toBe(serveHandler);
	});

	it("/authorize・/register・/token のエンドポイントを持つ", () => {
		expect(options.authorizeEndpoint).toBe("/authorize");
		expect(options.clientRegistrationEndpoint).toBe("/register");
		expect(options.tokenEndpoint).toBe("/token");
	});

	it("defaultHandler に GitHubHandler を使う", () => {
		expect(options.defaultHandler).toBeDefined();
	});

	it("fetch を OAuthProvider インスタンスの fetch に委譲する", async () => {
		const response = new Response("ok");
		providerFetch.mockResolvedValue(response);

		const request = new Request("https://example.com/mcp");
		const env = {} as never;
		const ctx = {} as never;
		await expect(worker.default.fetch(request, env, ctx)).resolves.toBe(response);

		expect(providerFetch).toHaveBeenCalledTimes(1);
		expect(providerFetch).toHaveBeenCalledWith(request, env, ctx);
	});
});

describe("ReminderMCP", () => {
	it("サーバー名・バージョンと指示文を McpServer に渡す", async () => {
		const { SERVER_INSTRUCTIONS } = await import("./instructions");
		const instance = new (worker.ReminderMCP as unknown as new () => {
			server: { info: unknown; options: unknown };
			init(): Promise<void>;
		})();

		expect(instance.server.info).toEqual({ name: "絶対伝えろよリマインダー", version: "0.1.0" });
		expect(instance.server.options).toEqual({ instructions: SERVER_INSTRUCTIONS });
		await expect(instance.init()).resolves.toBeUndefined();
	});
});

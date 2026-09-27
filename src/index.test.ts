import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderRepo } from "./repo/reminders";

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

const githubHandler = { fetch: vi.fn() };
vi.mock("./auth/github-handler", () => ({ GitHubHandler: githubHandler }));

const registerReminderTools =
	vi.fn<(server: unknown, deps: { repo: unknown; clock?: () => number }) => void>();

vi.mock("./tools/register", () => ({
	registerReminderTools: (server: unknown, deps: { repo: unknown; clock?: () => number }) =>
		registerReminderTools(server, deps),
}));

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
		expect(options.defaultHandler).toBe(githubHandler);
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

type ReminderMCPInstance = {
	server: { info: unknown; options: unknown };
	env: { DB: unknown };
	init(): Promise<void>;
};

function newAgent(): ReminderMCPInstance {
	const instance = new (worker.ReminderMCP as unknown as new () => ReminderMCPInstance)();
	instance.env = { DB: {} };
	return instance;
}

describe("ReminderMCP", () => {
	beforeEach(() => {
		registerReminderTools.mockReset();
	});

	it("サーバー名・バージョンと指示文を McpServer に渡す", async () => {
		const { SERVER_INSTRUCTIONS } = await import("./instructions");
		const instance = newAgent();

		expect(instance.server.info).toEqual({ name: "絶対伝えろよリマインダー", version: "0.1.0" });
		expect(instance.server.options).toEqual({ instructions: SERVER_INSTRUCTIONS });
		await expect(instance.init()).resolves.toBeUndefined();
	});

	it("init() が registerReminderTools に server と DB のリポジトリを渡す", async () => {
		const instance = newAgent();

		await instance.init();

		expect(registerReminderTools).toHaveBeenCalledTimes(1);
		const [server, deps] = registerReminderTools.mock.calls[0];
		expect(server).toBe(instance.server);
		expect(deps.repo).toBeInstanceOf(ReminderRepo);
		expect(deps.clock).toBe(Date.now);
	});
});

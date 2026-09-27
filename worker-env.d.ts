// wrangler types が生成する worker-configuration.d.ts（`interface Env` と `Cloudflare.Env`）に
// マージする手書きの型補強。secret は値を wrangler secret put で設定するため生成型に現れない。
interface WorkerSecrets {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
}

declare namespace Cloudflare {
	interface Env extends WorkerSecrets {}
}

// src/auth/ は流用元のまま global の `Env` を参照するので、そちらにも同じ補強を効かせる
interface Env extends WorkerSecrets {}

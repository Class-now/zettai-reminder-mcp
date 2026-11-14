# Plan: Phase 1 — 絶対伝えろよリマインダー MCP サーバー本体

個人用リモート MCP サーバー。claude.ai のカスタムコネクタとして接続し、新しい会話の最初の応答前に Claude が `check_board` を呼ぶと、表示時刻を過ぎた未アーカイブのリマインダーを返し、同時にアーカイブする。利用者は本人 1 名のみ。

- 実行環境: Cloudflare Workers（無料プラン）、TypeScript、Worker は 1 つ
- データ: Cloudflare D1（binding `DB`）。OAuth トークンだけ Workers KV（binding `OAUTH_KV`）
- 認証: `@cloudflare/workers-oauth-provider`（Worker 自身が OAuth 2.1 認可サーバー、動的クライアント登録＋PKCE S256）。上流 IdP は GitHub OAuth。`ALLOWED_GITHUB_USER_ID` と一致する GitHub ユーザーだけ通す。`src/auth/` に流用元のファイルがコミット済み
- MCP: `agents/mcp` の `McpAgent`（Durable Object binding `MCP_OBJECT`）＋ `@modelcontextprotocol/sdk` の `McpServer`。Streamable HTTP の窓口は `/mcp`
- テスト: Vitest（node 環境）。D1 は `node:sqlite`（Node 24 以上で無フラグで使える）で作るテスト用アダプタで代替する

この Phase ではリモート環境（D1/KV の作成、secret 設定、デプロイ）には一切触れない。`wrangler.jsonc` の ID はプレースホルダのままでよい。

**Status**: Phase 1 完了（全 5 タスク、2026-09-27）。`npm run typecheck` / `npm test` / `npx wrangler deploy --dry-run` が通る状態。次は Phase 2（`docs/process.md` の TASK-P2-001〜005、PM が直接実行）。手順は SETUP.md。

## Validation Commands

- `npm run typecheck`
- `npm test`
- `npx wrangler deploy --dry-run --outdir .wrangler/dry-run`

### Task 1: プロジェクト土台（Worker・OAuth・McpAgent の骨格）

**Purpose**: personal-rag-mcp と同じ認証・MCP 構成で、ツールを 1 つも持たない Worker を起動可能にする。

**現状**: リポジトリには `CLAUDE.md`、`.gitignore`、`tsconfig.json`（流用元のまま）、`src/auth/github-handler.ts`・`src/auth/utils.ts`・`src/auth/workers-oauth-utils.ts`（流用元のまま）だけがある。

**作るもの**:

1. `package.json`（name `zettai-reminder-mcp`、private、`"type": "module"`）
   - dependencies（バージョン固定の目安。流用元で動作実績あり）: `@cloudflare/workers-oauth-provider` ^0.2.3、`agents` ^0.5.0、`@modelcontextprotocol/sdk` ^1.26.0、`hono` ^4.12.0、`octokit` ^5.0.5、`zod` ^4.3.6
   - devDependencies: `typescript` 5.9.3、`vitest` ^4.1.9、`wrangler` ^4.67.0、`@types/node`（最新）。`@cloudflare/workers-types` は入れない（Workers の型は `wrangler types` が出す `worker-configuration.d.ts` を使う）
   - `engines.node` は `>=24`（`node:sqlite` が無フラグで使える版）
   - scripts: `"dev": "wrangler dev"`、`"test": "vitest run"`、`"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.worker.json"`（2 本目は Worker 本体だけを Workers の型でチェックする）、`"cf-typegen": "wrangler types"`、`"deploy": "npm run typecheck && npm test && wrangler deploy"`、`"db:migrate:local": "wrangler d1 migrations apply zettai-reminder --local"`、`"db:migrate:remote": "wrangler d1 migrations apply zettai-reminder --remote"`
   - `npm install` を実行し `package-lock.json` をコミットする
2. `wrangler.jsonc`
   ```jsonc
   {
     "$schema": "node_modules/wrangler/config-schema.json",
     "name": "zettai-reminder-mcp",
     "main": "src/index.ts",
     "compatibility_date": "2025-03-10",
     "compatibility_flags": ["nodejs_compat"],
     // secrets（値はここに書かない）: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY
     "migrations": [{ "new_sqlite_classes": ["ReminderMCP"], "tag": "v1" }],
     "durable_objects": { "bindings": [{ "class_name": "ReminderMCP", "name": "MCP_OBJECT" }] },
     "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "00000000000000000000000000000000" }],
     "d1_databases": [{ "binding": "DB", "database_name": "zettai-reminder", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "migrations" }],
     "vars": { "ALLOWED_GITHUB_USER_ID": "255099949" },
     "observability": { "enabled": true },
     "dev": { "port": 8789 }
   }
   ```
   ID のプレースホルダは Phase 2 で PM が実 ID に置き換える（コメントで明記）。
3. `worker-env.d.ts`（手書きの型補強。`wrangler types` の生成型 `worker-configuration.d.ts` にマージする）
   ```ts
   declare namespace Cloudflare {
     interface Env {
       GITHUB_CLIENT_ID: string;
       GITHUB_CLIENT_SECRET: string;
       COOKIE_ENCRYPTION_KEY: string;
     }
   }
   ```
   `npm run cf-typegen` で `worker-configuration.d.ts` を生成してコミットする。`tsconfig.json` は流用元をほぼそのまま使い、`"types"` を `["./worker-configuration.d.ts", "node"]`、`"exclude"` を `["node_modules", ".wrangler"]` に直して、テストファイル（`src/**/*.test.ts`）と運用スクリプトも型検査に含まれることを確認する。さらに `tsconfig.worker.json`（`tsconfig.json` を継承し、`"types": ["./worker-configuration.d.ts"]`、`include` は `src/**/*.ts` と `worker-env.d.ts`、`exclude` は `src/**/*.test.ts` と `src/test-utils`）を置き、Worker 本体に node の型が混ざらないことを別パスで確かめる。vitest のグローバルは import で使う（`import { describe, it, expect } from "vitest"`）。
4. `src/types.ts`: `export type Env = Cloudflare.Env;`
5. `src/auth/github-handler.ts` の承認画面の表示文言だけを変える: `name: "絶対伝えろよリマインダー"`、`description: "リマインダーサーバーへの接続を承認する（GitHub アカウントで認証）。"`。それ以外のロジック（CSRF、state、`ALLOWED_GITHUB_USER_ID` の照合）は一切変えない。`src/auth/utils.ts` の `Props` 型もそのまま使う。
6. `src/index.ts`（流用元の構成。下の形に揃える）
   ```ts
   import OAuthProvider from "@cloudflare/workers-oauth-provider";
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { McpAgent } from "agents/mcp";
   import { GitHubHandler } from "./auth/github-handler";
   import type { Props } from "./auth/utils";
   import type { Env } from "./types";

   export class ReminderMCP extends McpAgent<Env, Record<string, never>, Props> {
     server = new McpServer({ name: "絶対伝えろよリマインダー", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
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
   ```
   `SERVER_INSTRUCTIONS` は `src/instructions.ts` に置く短い日本語文（Task 4 で本文を入れる。ここでは仮の 1 文でよい）。scheduled ハンドラ・cron は持たない（常駐スケジューラを置かない設計）。
7. `src/index.test.ts`: node 環境の vitest では `agents/mcp`・`@cloudflare/workers-oauth-provider`・`./auth/github-handler` が `cloudflare:` スキームの import に依存して読み込めない。流用元と同じく `vi.mock` で最小モックを挟み（`McpAgent` は `static serve() { return { fetch: vi.fn() } }` を持つクラス、OAuthProvider は `fetch = vi.fn()` を持つクラス、`GitHubHandler: {}`）、`default.fetch` がリクエストを OAuthProvider インスタンスの `fetch` に委譲することと、`ReminderMCP` が export されていることを検証する。

**Requirements**: REQ-N004（認証されていないリクエストを 100% 拒否。OAuthProvider が `/mcp` への Bearer トークン無し・無効リクエストを 401 にする）、CON-002、CON-005。

- [x] `npm install` が成功し `package.json` と `package-lock.json` がコミットされている
- [x] `wrangler.jsonc` に `DB`（D1）・`OAUTH_KV`（KV）・`MCP_OBJECT`（DO、class `ReminderMCP`）の 3 binding と `ALLOWED_GITHUB_USER_ID` がある
- [x] `src/index.ts` が OAuthProvider に `/mcp` を `ReminderMCP.serve("/mcp")` で登録し、`/authorize` `/register` `/token` を持つ
- [x] `src/auth/` の変更は承認画面の `name` と `description` の文字列だけである（`git diff` で確認）
- [x] `npm run typecheck` と `npm test` が通る
- [x] `npx wrangler deploy --dry-run --outdir .wrangler/dry-run` が成功する

Do NOT implement: リマインダーのツール・D1 のスキーマ（Task 2〜4）、scheduled ハンドラや cron、専用 GUI、リモート環境への操作（`wrangler d1 create`・`wrangler kv namespace create`・`wrangler secret put`・`wrangler deploy` 本番実行）。

### Task 2: 日時ユーティリティ（日本時間固定）

**Purpose**: 日時を常に日本時間（`+09:00`）の文字列で受け取り・保存・比較するための純粋関数群を作る。外部ライブラリは使わない（日本は夏時間が無いので固定オフセットで足りる）。

**Design Context**:

- ファイル: `src/lib/datetime.ts`、テスト `src/lib/datetime.test.ts`
- 保存形式は `YYYY-MM-DDTHH:MM:SS+09:00`（秒まで、オフセット固定）。全行のオフセットが同じなので、文字列のまま大小比較できる
- 関数（名前と挙動をこの通りに実装する）:
  - `nowJst(nowMs?: number): string` — 現在時刻（省略時 `Date.now()`）を保存形式で返す。`new Date(ms + 9h).toISOString()` を元に組み立て、実行環境のローカルタイムゾーンに依存しない。ミリ秒は切り捨て
  - `parseJstDateTime(input: string): string` — `YYYY-MM-DDTHH:MM` または `YYYY-MM-DDTHH:MM:SS` の後ろに `+09:00` が付いた文字列だけを受け付け、秒が無ければ `:00` を補って保存形式で返す。オフセット無し・`Z`・`+09:00` 以外のオフセット・実在しない日付（2026-02-30、25:00 など）は `DateTimeError`（`code = "INVALID_DATETIME"`）を投げる
  - `parseJstDue(input: string): string` — 期限用。`parseJstDateTime` が受け付ける形式に加え、日付のみ `YYYY-MM-DD` を受け付け、その日の `23:59:00+09:00` にする
  - `daysUntil(dueAt: string, now: string): number` — 日本時間の暦日の差（due の日付 − now の日付）。時刻は無視する。例: now `2026-10-03T23:00:00+09:00`、due `2026-10-05T08:00:00+09:00` → 2。当日は 0、過ぎていれば負
  - `formatMonthDay(dt: string): string` → `10/3`（月・日の先頭ゼロなし）
  - `formatMonthDayTime(dt: string): string` → `10/3 08:00`（時・分は 2 桁）
  - `class DateTimeError extends Error { code = "INVALID_DATETIME" }`

**Requirements**: REQ-F007（表示時刻・期限・登録日時はすべて日本時間として解釈・保存・比較する。「10/3 8:00」で登録したものは日本時間 10/3 7:59 の参照ではボードに含まれず、8:00 以降の参照で含まれる）、REQ-F023（残り日数）。

- [x] 上記 7 つの export が `src/lib/datetime.ts` にある
- [x] `nowJst` のテストが `process.env.TZ` を `America/New_York` と `UTC` に変えても同じ結果になる（`nowMs` 固定で検証）
- [x] `parseJstDateTime` がオフセット無し・`Z`・`+00:00`・`2026-02-30T10:00+09:00`・`2026-10-03T25:00+09:00` を `INVALID_DATETIME` で拒否するテストがある
- [x] `parseJstDue("2026-10-05")` が `2026-10-05T23:59:00+09:00` を返すテストがある
- [x] `daysUntil` の当日 0・翌々日 2・前日 −1 と、日付境界（23:59 と 00:00）のテストがある
- [x] `npm run typecheck` と `npm test` が通る

Do NOT implement: 自然言語の時刻解釈（「明日の朝」などは Claude 側が具体的な日時に直してから渡す）、他のタイムゾーンへの対応、date-fns 等の依存追加。

### Task 3: D1 スキーマとリマインダーリポジトリ

**Purpose**: D1 のテーブルと、すべての SQL をまとめたリポジトリ層を作る。取得とアーカイブは 1 文の `UPDATE … RETURNING` で不可分に行う。

**Design Context**:

マイグレーション `migrations/0001_init.sql`:

```sql
CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,                -- crypto.randomUUID()
  body        TEXT NOT NULL CHECK (length(body) >= 1),
  show_at     TEXT NOT NULL,                   -- YYYY-MM-DDTHH:MM:SS+09:00
  due_at      TEXT,                            -- 同上、NULL 可
  note        TEXT,                            -- 会話メモ、NULL 可
  kind        TEXT NOT NULL CHECK (kind IN ('explicit','auto')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,                            -- 取得日時。NULL でなければアーカイブ済み
  deleted_at  TEXT                             -- 論理削除日時
);
CREATE INDEX idx_reminders_active ON reminders(show_at) WHERE archived_at IS NULL AND deleted_at IS NULL;

CREATE TABLE board_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at     TEXT NOT NULL,
  returned_count INTEGER NOT NULL CHECK (returned_count >= 0),
  ok             INTEGER NOT NULL CHECK (ok IN (0,1)),
  error_code     TEXT,
  duration_ms    INTEGER NOT NULL
);
```

状態は列で持たず、`show_at`・`archived_at`・`deleted_at` と現在時刻の比較で決まる:
- メインボード = `archived_at IS NULL AND deleted_at IS NULL AND show_at <= :now`
- 待機中 = `archived_at IS NULL AND deleted_at IS NULL AND show_at > :now`
- アクティブ = `archived_at IS NULL AND deleted_at IS NULL`
- アーカイブ済み = `archived_at IS NOT NULL AND deleted_at IS NULL`

リポジトリ `src/repo/reminders.ts`（`D1Database` を受け取るクラス `ReminderRepo`。`now` は引数で受け取り、内部で時計を読まない）:

| メソッド | SQL（要旨） |
|---|---|
| `takeBoard(now, limit)` | `UPDATE reminders SET archived_at = ?1 WHERE id IN (SELECT id FROM reminders WHERE archived_at IS NULL AND deleted_at IS NULL AND show_at <= ?1 ORDER BY show_at, id LIMIT ?2) RETURNING id, body, show_at, due_at, kind` — これ 1 文だけ。別文としての事前 SELECT は禁止（件数を絞る副問い合わせは同じ 1 文の中）。上限が無いと D1 の応答上限（1MB）超過で 1 文が失敗し続け、1 件もアーカイブできずに恒久的に詰まる |
| `recordCheck({checkedAt, returnedCount, ok, errorCode, durationMs})` | `INSERT INTO board_checks …`。`takeBoard` と `db.batch()` でまとめない（記録失敗で取得結果を失わないため） |
| `insert({body, showAt, dueAt, note, kind}, now)` | `showAt` が省略または `now` より前なら `now` を入れる。`created_at = updated_at = now`。挿入した行を返す |
| `listWaiting(now, limit)` | 待機中を `ORDER BY show_at, id LIMIT ?` |
| `listActive(limit)` | アクティブを `ORDER BY show_at, id LIMIT ?`（重複確認用）。一覧は必ず `LIMIT` を持たせる |
| `listArchived(limit)` | アーカイブ済みを `ORDER BY archived_at DESC, show_at DESC, id LIMIT ?` |
| `update(id, patch, now)` | `UPDATE reminders SET <patch の列>, updated_at = ? WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL RETURNING *`。patch は body / show_at / due_at（null で消去可）/ note（null で消去可）。`show_at` が `now` より前なら `now` に置き換える。0 行なら `null` を返す |
| `softDelete(id, now)` | `UPDATE reminders SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND archived_at IS NULL AND deleted_at IS NULL RETURNING id`。0 行なら `false` |

- 行は snake_case のまま返さず、`Reminder` 型（camelCase: `id, body, showAt, dueAt, note, kind, createdAt, updatedAt, archivedAt`）に変換する
- `takeBoard` の結果の並べ替えはリポジトリでは行わない（Task 4 のサービス層で行う）
- 保持期間は未決定のため、物理削除の処理は作らない

テスト用 D1 アダプタ `src/test-utils/sqlite-d1.ts`: Node 内蔵の `node:sqlite`（`DatabaseSync`）で `D1Database` のうちリポジトリが使う部分（`prepare(sql).bind(...args)` → `first()` / `all()` / `run()`）を実装し、`migrations/0001_init.sql` を読み込んで空の DB を作る関数 `createTestD1()` を export する。`?1` 形式の番号付きパラメータが使えることを確認する（使えなければリポジトリ側は `?` の位置パラメータに統一する）。このファイルはテスト専用で、Worker のバンドルに入れない。

**Requirements**: REQ-F003（本文・表示時刻・期限・会話メモ・登録種別・登録日時を持つ）、REQ-F006（過去の表示時刻は即時）、REQ-F015、REQ-F017〜REQ-F020、REQ-F027（取得とアーカイブの不可分性）、REQ-F028（取得日時の記録）、REQ-F029（参照記録）、REQ-N006（二重表示 0 件）。

- [x] `migrations/0001_init.sql` が上記の 2 テーブルと部分インデックスを作る
- [x] `ReminderRepo` の 8 メソッドがあり、SQL はすべて `src/repo/` 内にある
- [x] `takeBoard` の実装が SQL 1 文（`UPDATE … RETURNING`）だけで、別文の SELECT を先に発行しないことをコードで確認できる
- [x] テスト: 表示時刻が `now` ちょうどの行は取得され、`now` の 1 分後の行は取得されない
- [x] テスト: `takeBoard` を 2 回続けて呼ぶと、2 回目は 0 件になり、1 回目に返った行の `archived_at` が `now` になっている
- [x] テスト: 削除済み・アーカイブ済みの行は `takeBoard`・`listWaiting`・`listActive` に出ず、`update`・`softDelete` は 0 行（`null` / `false`）になる
- [x] テスト: `insert` で過去の `showAt` と省略時の `showAt` がどちらも `now` になる
- [x] テスト: `listArchived` が取得日時の新しい順で、`limit` を守る
- [x] テスト: `takeBoard` が `limit` を守り、超えた分は表示時刻の古い順に残って次の `takeBoard` で返る
- [x] `npm run typecheck` と `npm test` が通る

Do NOT implement: MCP ツール（Task 4）、物理削除・保持期間の処理、利用者列（本人 1 名のみ）、スヌーズや繰り返し。

### Task 4: MCP ツール 5 本とサーバー指示文

**Purpose**: Claude が呼ぶ 5 つのツールを実装し、`ReminderMCP.init()` で登録する。Claude に計算や整形をさせない値（並び順・残り日数・表示用の 1 行）はサーバーが作って返す。

**Design Context**:

構成: 純粋なサービス層 `src/service/reminders.ts`（`ReminderRepo` と `clock: () => number` を受け取る。テスト可能にする）と、MCP 登録層 `src/tools/register.ts`（`registerReminderTools(server: McpServer, deps)`、zod で入力スキーマを定義）。`ReminderMCP.init()` で `new ReminderRepo(this.env.DB)` と `Date.now` を渡して登録する。

**応答の形式（全ツール共通）**: 成功時は `{ content: [{ type: "text", text: JSON.stringify(result) }] }`。失敗時は `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] }`。エラーコード: `INVALID_DATETIME`（日時の形式違反）、`VALIDATION_ERROR`（それ以外の入力違反）、`NOT_FOUND`（対象が待機中/アクティブに無い）、`DB_ERROR`（D1 の失敗）。

**ツール仕様**:

1. `check_board`（入力なし）— 新しい会話の最初の応答前に 1 回だけ呼ばれる
   - 処理: 受信時刻を `performance.now()`（または `Date.now()`）で記録 → `now = nowJst()` → `repo.takeBoard(now, 50)` → 並べ替え → `repo.recordCheck(...)`（`duration_ms` = 受信から応答オブジェクト完成まで。記録の失敗は `console.error` だけで握りつぶし、応答は返す）
   - 1 回に取るのは 50 件まで（`BOARD_TAKE_LIMIT`）。超えた分は表示時刻の古い順に残って次の呼び出しで返る（D1 の応答上限 1MB を 1 文で超えると恒久的に詰まるため）。件数が上限に達したときは `has_more: true` を付けて、取り切れていないことを黙って隠さない
   - 並び順: 期限の近い順、期限なしは後ろ、同じ期限（または期限なし同士）は `show_at` 昇順、それも同じなら `id` 昇順（`UPDATE … RETURNING` の行順は保証されないため）
   - 0 件のとき: 追加の処理をせず、正確に `{"count":0,"items":[]}` を返す（空ボードの経路を最短にする。目標はサーバー処理 100ms 以内）
   - 1 件以上: `{ count, items: [{ id, body, due_at, days_left, show_at, kind, line }] }`。`due_at` と `days_left` は期限なしなら `null`。`line` は表示用の完成済み 1 行:
     - 期限あり・`days_left > 0`: `・[本文]（期限 M/D、あと N 日）`
     - 期限あり・`days_left == 0`: `・[本文]（期限 M/D、今日まで）`
     - 期限あり・`days_left < 0`: `・[本文]（期限 M/D、N 日超過）`（N は絶対値）
     - 期限なし: `・[本文]`
     - 会話メモ（note）は返さない
   - D1 が失敗したら `recordCheck` を `ok=0, error_code="DB_ERROR", returned_count=0` で試み（これも失敗したら握りつぶす）、`DB_ERROR` を返す
2. `add_reminder` — 入力: `body`（1〜200 文字、必須。連続する空白と改行は半角スペース 1 個に畳んで必ず 1 行にする。単独の全角スペースは畳まずそのまま残す。`line` と `confirmation` にそのまま埋め込むため）、`kind`（`"explicit" | "auto"`、必須）、`show_at`（任意、`+09:00` 付き日時。省略＝即時）、`due_at`（任意、`+09:00` 付き日時または `YYYY-MM-DD`）、`note`（任意、1000 文字以内）。`show_at` / `due_at` / `note` は `null` も省略と同じに扱う（`update_reminder` が `null` を消去の意味で受けるため、同じ値で弾かない）
   - `show_at` が省略または過去なら登録時刻にする（リポジトリが行う）
   - 返り値: `{ reminder: { id, body, show_at, due_at, note, kind, created_at }, confirmation }`。`confirmation` は `登録しました：[本文]（表示 M/D HH:MM）`、期限があれば `登録しました：[本文]（表示 M/D HH:MM、期限 M/D）`
3. `list_reminders` — 入力: `status`（`"waiting" | "active" | "archived"`、必須）、`limit`（任意、3 ステータスすべてで有効、1〜100。既定は archived が 20、waiting / active が 100。`null` は省略と同じ）
   - waiting = 表示時刻前の一覧、active = アーカイブされていない行（重複確認用）、archived = 見返し（`archived_at` 付き、新しい順）
   - どのステータスも `LIMIT` を持たせる（「一覧は必ず `LIMIT`」の恒久ルール）。`limit + 1` 件取って切り捨てることで、打ち切りがあったときだけ `has_more: true` を付ける（重複確認の一覧が黙って欠けると重複登録に気づけない）
   - 返り値: `{ status, count, items: [{ id, body, show_at, due_at, note, kind, created_at, archived_at }] }`。どの行の状態も変えない
4. `update_reminder` — 入力: `id`（必須）と、`body`（1〜200 文字、`add_reminder` と同じ正規化。`null` は指定なしと同じ）/ `show_at`（`null` は指定なしと同じ。消せない列なので消去の意味は持たない）/ `due_at`（`null` で期限を消す）/ `note`（`null` で消す）のうち 1 つ以上
   - アーカイブ済み・削除済み・存在しない id は `NOT_FOUND`。更新項目が 1 つも無ければ `VALIDATION_ERROR`
   - 返り値: `{ reminder: {...}, confirmation: "更新しました：[本文]（表示 M/D HH:MM[、期限 M/D]）" }`
5. `snooze_reminder`（フェーズ 1 の後に追加）— 入力: `id`・`show_at`（必須）。取得済み（`archived_at IS NOT NULL AND deleted_at IS NULL`）の行を `UPDATE … SET archived_at = NULL, show_at = max(show_at, now) … RETURNING` の 1 文で待機中に戻す。新しい行は作らない。無ければ `NOT_FOUND`。返り値 `{ reminder, confirmation }`（「もう一度出します：…」）
6. `delete_reminder` — 入力: `id`（必須）。アクティブな行だけを論理削除。無ければ `NOT_FOUND`。返り値 `{ deleted: id }`

各ツールの `description`（日本語）には、いつ呼ぶか・何を返すかを 1〜3 文で書く。特に `check_board` は「新しい会話の最初の応答を書く前に 1 回だけ呼ぶ。返された `line` を応答の 1 行目から順にそのまま書く。0 件なら何も書かない。」と書く。

**サーバー指示文** `src/instructions.ts` の `SERVER_INSTRUCTIONS`（McpServer の `instructions` に渡す）: 次の要旨を日本語で 8 行以内にまとめる。
- 新しい会話では最初の応答を書く前に `check_board` を 1 回だけ呼ぶ。会話履歴に過去の応答があれば呼ばない（2026-10-17 改訂。Claude Code からの呼び出しはサーバー側で skipped にする。README 参照）
- 1 件以上なら、起動中のスキルや文脈に関係なく、応答の 1 行目から `line` を返された順に全件書く。0 件なら何も書かない。失敗したら 1 行目に「リマインダーを確認できませんでした」
- 登録を頼まれたら曖昧な時刻を `+09:00` 付きの日時に直して `add_reminder(kind="explicit")`、同じ応答に `confirmation` を 1 行書く
- 具体的な行動と義務・予定の言い回し（「〜しなきゃ」「〜する予定」「〜の予約がある」）の両方がある発話は、依頼がなくても `list_reminders(status="active")` で重複を確かめてから `add_reminder(kind="auto")` し、応答の最終行に `confirmation` を書く。同じタスクがあれば新しい期限・日時があるときだけ `update_reminder`。日時の無いタスクは登録せず、登録してよいか尋ねて次の発話が肯定のときだけ登録する（README.md と SETUP.md 手順 8 の項目 7 と同じ文言にする）

**Requirements**: REQ-F001〜REQ-F003、REQ-F005、REQ-F006、REQ-F013、REQ-F014、REQ-F015〜REQ-F020、REQ-F023〜REQ-F025、REQ-F027〜REQ-F030、REQ-N001、REQ-N002、REQ-N006。

- [x] 5 ツール（`check_board`、`add_reminder`、`list_reminders`、`update_reminder`、`delete_reminder`）が `registerReminderTools` で登録され、`ReminderMCP.init()` から呼ばれている
- [x] テスト（サービス層、`createTestD1()` を使用）: 期限 10/5・期限 10/3・期限なしの 3 件が 10/3・10/5・期限なしの順で返る
- [x] テスト: 期限 10/5 のリマインダーを 10/3 に取得すると `line` が `・[本文]（期限 10/5、あと 2 日）` になり、`note` が応答に含まれない
- [x] テスト: 0 件の `check_board` の text が正確に `{"count":0,"items":[]}` で、`board_checks` に `returned_count=0, ok=1` の行が 1 件増える
- [x] テスト: `check_board` を 3 回呼ぶと `board_checks` が 3 行増え、同じリマインダーは 1 回しか返らない
- [x] テスト: `recordCheck` が例外を投げても `check_board` は取得結果を返す。`takeBoard` が例外を投げたら `isError: true` と `DB_ERROR` を返す
- [x] テスト: `add_reminder` の `confirmation` が期限の有無で 2 形式になり、`show_at` 省略・過去の両方で登録時刻になる。`kind` が保存される
- [x] テスト: オフセット無しの `show_at` は `INVALID_DATETIME`、空の `body` は `VALIDATION_ERROR`
- [x] テスト: `list_reminders` の 3 ステータスが正しい集合を返し、呼んでも行の状態が変わらない（呼ぶ前後で `check_board` の結果が同じ）
- [x] テスト: `update_reminder` で表示時刻を未来に動かすと、その時刻より前の `check_board` には出ない。存在しない id・アーカイブ済み id は `NOT_FOUND`
- [x] テスト: `delete_reminder` 後は `check_board`・`list_reminders(waiting/active)` に出ない
- [x] `npm run typecheck`、`npm test`、`npx wrangler deploy --dry-run --outdir .wrangler/dry-run` が通る

Do NOT implement: 会話中に表示時刻を迎えたものの即時通知、スヌーズ・繰り返し、Claude Code 向けの機能、専用 GUI、物理削除、プッシュ通知。

### Task 5: 運用ドキュメントと計測スクリプト

**Purpose**: デプロイと claude.ai への接続を PM が手順通りに実行でき、空ボード時の処理時間（SPIKE-001）を参照記録から集計できるようにする。

**Design Context**:

1. `README.md`（日本語）: 概要（3 行）、構成（Worker 1 つ・D1・KV・OAuth）、ツール 5 本の一覧（名前・入力・返り値の要旨）、コマンド一覧、下記の指示文
2. `SETUP.md`（日本語）: 初回セットアップ手順を番号付きで書く。値は書かず、環境変数名とコマンドだけを書く
   1. `npx wrangler d1 create zettai-reminder --location <hint>` → 返った `database_id` を `wrangler.jsonc` に書く（location hint は SPIKE-001 で決める。候補 `enam` / `wnam` / `apac`）
   2. `npx wrangler kv namespace create OAUTH_KV` → `id` を `wrangler.jsonc` に書く
   3. GitHub OAuth App を作る（Homepage `https://zettai-reminder-mcp.<subdomain>.workers.dev`、Callback `https://zettai-reminder-mcp.<subdomain>.workers.dev/callback`）
   4. `npx wrangler secret put GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `COOKIE_ENCRYPTION_KEY`（`openssl rand -hex 32`）
   5. `npm run db:migrate:remote`
   6. `npm run deploy`
   7. claude.ai → 設定 → コネクタ → カスタムコネクタ追加（URL `https://zettai-reminder-mcp.<subdomain>.workers.dev/mcp`）→ GitHub で認可
   8. claude.ai のユーザー設定（個人設定の指示）の末尾に下記の指示文を追記する
   9. 確認: 新しい会話で `check_board` が呼ばれ、`npm run report:checks` に 1 行増える
   - `src/auth/github-handler.ts` の callback 経路が `/callback` であることをコードで確認してから書く（違えば実際の経路を書く）
3. 指示文（README と SETUP の両方に、次の文面をそのままコードブロックで載せる。ツール名は実装と一致している）:
   ```
   【リマインダー】
   1. 新しい会話では、最初の応答を書く前に、リマインダーの check_board を1回だけ呼ぶ。同じ会話の2回目以降の応答では呼ばない。
   2. check_board が1件以上返したら、起動中のスキルやそれまでの文脈に関係なく、応答の1行目から各項目の line を返された順にそのまま書く。会話メモは書かない。その後に通常の応答を続ける。
   3. check_board が0件なら、リマインダーについて何も書かない。
   4. check_board が失敗したら、応答の1行目に「リマインダーを確認できませんでした」と書く。
   5. 登録を頼まれたら、曖昧な時刻を日本時間の具体的な日時（+09:00付き）に直して add_reminder(kind="explicit") を呼び、同じ応答に返された confirmation の1行を書く。
   6. どの会話でも、本人の発話に具体的な行動と、義務や予定を示す言い回し（「〜しなきゃ」「〜する予定」「〜の予約がある」など）の両方があれば、依頼がなくても登録する。先に list_reminders(status="active") で同じタスクがないか確かめる。あれば、新しい期限や日時があるときだけ update_reminder で更新する。なければ add_reminder(kind="auto") で登録し、応答の最終行に confirmation を書く。
   7. 日時を含まないタスクは登録せず、登録してよいか尋ねる。次の発話が肯定のときだけ登録する。曖昧な願望や雑談は登録しない。
   ```
4. `package.json` に計測用 scripts を追加:
   - `"report:checks": "wrangler d1 execute zettai-reminder --remote --command \"SELECT checked_at, returned_count, ok, error_code, duration_ms FROM board_checks ORDER BY id DESC LIMIT 50\""`
   - `"report:latency": "wrangler d1 execute zettai-reminder --remote --file scripts/latency-report.sql"`
5. `scripts/latency-report.sql`: `board_checks` から、空ボード（`returned_count = 0 AND ok = 1`）と非空（`returned_count > 0 AND ok = 1`）それぞれの件数・平均・最大の `duration_ms`、および 100ms（空）/ 500ms（非空）を超えた件数を 1 つの SELECT（UNION ALL 可）で返す。ローカル D1（`--local`）でも実行できる SQL にする
6. `scripts/latency-report.test.ts`: `createTestD1()` に `board_checks` のテスト行を入れ、`latency-report.sql` を実行して集計値が正しいことを確認する

**Requirements**: REQ-N001（空ボード 100ms 以内）、REQ-N002（非空 500ms 以内）、REQ-N004（秘密値を書かない）、REQ-N005（遵守率計測の材料＝参照記録）、SPIKE-001。

- [x] `README.md` と `SETUP.md` があり、どちらにも指示文がそのまま載っている
- [x] `SETUP.md` に秘密値そのものが書かれておらず、環境変数名とコマンドだけがある
- [x] `SETUP.md` の callback 経路が `src/auth/github-handler.ts` の実装と一致している
- [x] `report:checks` と `report:latency` が `package.json` にある
- [x] `scripts/latency-report.sql` の集計をテストで検証している
- [x] `npm run typecheck`、`npm test`、`npx wrangler deploy --dry-run --outdir .wrangler/dry-run` が通る

Do NOT implement: リモート環境への実行（D1/KV 作成・secret 設定・マイグレーション・デプロイ・claude.ai の設定変更。これらは Phase 2 で PM が行う）、遵守率の自動計算（分母を自動取得できないため）、ダッシュボード。

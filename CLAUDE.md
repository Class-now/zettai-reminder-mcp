# CLAUDE.md

絶対伝えろよリマインダー（リモート MCP サーバー、Cloudflare Workers）のコード規約。

## コマンド

- `npm run typecheck`（`tsc --noEmit` と `tsconfig.worker.json` の 2 本。後者は Worker 本体だけを Workers の型でチェックし、node の型を混ぜない）
- `npm test`（Vitest。`src/**/*.test.ts` と `scripts/**/*.test.ts`）
- `npm run deploy`（typecheck と test が通った時だけ wrangler deploy する）
- `npm run dev` / `npm run cf-typegen` / `npm run db:migrate:local` / `npm run db:migrate:remote` / `npm run report:checks` / `npm run report:latency`
- 変更を通す確認は `npm run typecheck` → `npm test` → `npx wrangler deploy --dry-run --outdir .wrangler/dry-run`
- 前提は Node 24 以上（`node:sqlite` が無フラグで使える版）

## 恒久ルール

- 日時は常に `YYYY-MM-DDTHH:MM:SS+09:00` 文字列で扱う。`Date` のローカルタイムゾーンに依存するコードを書かない（`src/lib/datetime.ts` だけを使う）
- 取得とアーカイブは `UPDATE … RETURNING` の 1 文で行う。SELECT してから UPDATE する 2 段階処理を書かない
- D1 への SQL は `src/repo/` にだけ書く。`src/repo/` は時計を読まない（現在時刻は呼び出し側が `now` として渡す）
- 層は 3 つに固定する。`src/tools/` は zod の入力スキーマと応答形式の変換だけ、`src/service/` が処理本体（MCP の型を import しない＝テストから直接呼べる）、`src/repo/` が SQL だけ
- 並び順・残り日数・表示用の 1 行（`line`）・確認文（`confirmation`）は必ず `src/service/` で作る。Claude に計算や整形をさせない
- ツールの応答形式は共通。成功は `{ content: [{ type: "text", text: JSON.stringify(result) }] }`、失敗は `isError: true` と `{ error: { code, message } }`。コードは `INVALID_DATETIME` / `VALIDATION_ERROR` / `NOT_FOUND` / `DB_ERROR` の 4 つだけ（`src/tools/register.ts` の `run()` が例外から変換する）
- 状態列は持たない。`show_at` / `archived_at` / `deleted_at` と `now` の比較で waiting / board / active / archived を決める。日時列は全行同じオフセットなので文字列の辞書順比較がそのまま時刻比較になり、SQL はそれに依存している
- 一覧は必ず `LIMIT` を持たせる（Claude の文脈に無制限に流し込まない）
- `worker-configuration.d.ts` は `npm run cf-typegen` の生成物。手で直さず、binding を変えたら再生成してコミットする。secret の型は `wrangler types` が出さないので `worker-env.d.ts` に手で足す
- 秘密値をコード・ドキュメント・Git に書かない。環境変数名だけを書く
- `src/auth/` は personal-rag-mcp からの流用。表示名・説明文以外は変更しない
- 指示文は 3 か所にある（`src/instructions.ts` の `SERVER_INSTRUCTIONS`、README.md、SETUP.md 手順 8）。片方だけ直さず同時に直す。`SERVER_INSTRUCTIONS` は 8 行以内・空行なし（`src/instructions.test.ts` が固定している）

## テスト

- D1 は `createTestD1()`（`src/test-utils/sqlite-d1.ts`。`node:sqlite` に `migrations/0001_init.sql` を適用する）で代替する。開いた DB は `afterEach` で `close()` する
- `src/test-utils/` は `src/index.ts` から到達させない（Worker のバンドルに入れない）
- node 環境の vitest では `agents/mcp` / `@cloudflare/workers-oauth-provider` / `src/auth/` が `cloudflare:` スキームの import を辿れず読めない。`src/index.ts` のテストは `vi.mock` で最小モックを挟む（`src/index.test.ts` が実例）
- 時計は `ReminderService` の `clock` に注入してテストする。`Date.now` を直接呼ぶテストを書かない

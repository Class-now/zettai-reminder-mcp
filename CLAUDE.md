# CLAUDE.md

絶対伝えろよリマインダー（リモート MCP サーバー、Cloudflare Workers）のコード規約。

## コマンド

- `npm run typecheck` / `npm test` / `npm run deploy`（deploy は typecheck と test が通った時だけ wrangler deploy する）

## 恒久ルール

- 日時は常に `YYYY-MM-DDTHH:MM:SS+09:00` 文字列で扱う。`Date` のローカルタイムゾーンに依存するコードを書かない（`src/lib/datetime.ts` だけを使う）
- 取得とアーカイブは `UPDATE … RETURNING` の 1 文で行う。SELECT してから UPDATE する 2 段階処理を書かない
- D1 への SQL は `src/repo/` にだけ書く
- 秘密値をコード・ドキュメント・Git に書かない。環境変数名だけを書く
- `src/auth/` は personal-rag-mcp からの流用。表示名・説明文以外は変更しない

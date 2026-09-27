# 絶対伝えろよリマインダー

claude.ai のカスタムコネクタとして接続する個人用のリモート MCP サーバー。新しい会話の最初の応答を書く前に Claude が `check_board` を呼ぶと、表示時刻を過ぎた未アーカイブのリマインダーを返し、同時にアーカイブする（同じものは二度返らない）。

Claude に計算や整形をさせない。並び順・残り日数・表示用の 1 行（`line`）はサーバーが作って返す。利用者は本人 1 名のみ。

## 構成

- Cloudflare Workers の Worker 1 つ（`src/index.ts`、TypeScript）
- Cloudflare D1（binding `DB`、DB 名 `zettai-reminder`）にリマインダーと参照記録を置く。SQL は `src/repo/` にだけ書く
- Workers KV（binding `OAUTH_KV`）に OAuth トークンだけを置く
- Durable Object（binding `MCP_OBJECT`、class `ReminderMCP`）が `agents/mcp` の `McpAgent`。Streamable HTTP の窓口は `/mcp`
- 認証は `@cloudflare/workers-oauth-provider`。Worker 自身が OAuth 2.1 認可サーバー（動的クライアント登録＋PKCE S256）で、上流 IdP は GitHub OAuth。`ALLOWED_GITHUB_USER_ID` と一致する GitHub ユーザーだけ通す
- 日時はすべて `YYYY-MM-DDTHH:MM:SS+09:00`（日本時間固定）の文字列。`src/lib/datetime.ts` だけを使う
- 前提は Node 24 以上（`package.json` の `engines`）。テストが D1 を `node:sqlite` で代替するため、これより古い Node では `npm test` が動かない

## ツール

応答は全ツール共通で、成功時が `{ content: [{ type: "text", text: <JSON> }] }`、失敗時が `isError: true` と `{ error: { code, message } }`。エラーコードは `INVALID_DATETIME` / `VALIDATION_ERROR` / `NOT_FOUND` / `DB_ERROR`。

この 4 コードになるのはサーバー側の処理で起きた失敗だけ。入力スキーマ違反（必須項目の欠落・enum 違反・`limit` の範囲外・型違い）は MCP SDK の zod 検証が先に弾くので、この封筒ではなくプロトコル側のエラーで返る。

| ツール | 入力 | 返り値 |
| --- | --- | --- |
| `check_board` | なし | `{ count, items: [{ id, body, due_at, days_left, show_at, kind, line }] }`。表示時刻を過ぎた分を 1 回 50 件まで返して同時にアーカイブする（超えた分は表示時刻の古い順に残り、次の呼び出しで返る）。上限に達したときだけ `has_more: true` が付く。期限の近い順（期限なしは後ろ、同着は `show_at`、それも同じなら `id` 昇順）。0 件のときは正確に `{"count":0,"items":[]}`。会話メモ（`note`）は返さない |
| `add_reminder` | `body`（必須、1〜200 文字。連続する空白と改行は半角スペース 1 個に畳む）、`kind`（`explicit` / `auto`、必須）、`show_at`（任意、省略または過去の時刻＝即時）、`due_at`（任意、日時または `YYYY-MM-DD`＝その日の 23:59）、`note`（任意、1000 文字以内） | `{ reminder, confirmation }`。`reminder` は `{ id, body, show_at, due_at, note, kind, created_at }`。`confirmation` は `登録しました：[本文]（表示 M/D HH:MM[、期限 M/D]）` |
| `list_reminders` | `status`（`waiting` / `active` / `archived`、必須）、`limit`（1〜100。既定は archived が 20、waiting / active が 100） | `{ status, count, items }`。`items` は `add_reminder` の `reminder` に `archived_at` が付いた形（`line` と `days_left` は付かない）。`limit` で切り捨てた分があるときだけ `has_more: true` が付く。どの行の状態も変えない |
| `update_reminder` | `id`（必須）と `body`（1〜200 文字）/ `show_at`（過去に動かすと即時になる）/ `due_at`（`null` で期限を消す）/ `note`（`null` で消す）のうち 1 つ以上 | `{ reminder, confirmation }`。`confirmation` は `更新しました：…` で同じ形。取得済み・削除済み・存在しない id は `NOT_FOUND` |
| `delete_reminder` | `id`（必須） | `{ deleted: id }`。論理削除。対象が無ければ `NOT_FOUND` |

`check_board` の `line` は次の 4 形。サーバーが完成させるので Claude は整形しない。

- 期限なし: `・[本文]`
- 期限が先: `・[本文]（期限 M/D、あと N 日）`
- 期限が当日: `・[本文]（期限 M/D、今日まで）`
- 期限切れ: `・[本文]（期限 M/D、N 日超過）`

`has_more` は「黙って欠けさせない」ための印。`check_board` では上限ちょうどで尽きた場合も `true` になる（残りの見落としより過剰な通知を採る）。`list_reminders(status="active")` を重複確認に使うとき `has_more` が `true` なら、一覧は全件ではない。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | ローカルで Worker を起動する（`http://localhost:8789`） |
| `npm run typecheck` | `tsc --noEmit`（テスト・スクリプト込み）と `tsconfig.worker.json`（Worker 本体だけを Workers の型で）の 2 本 |
| `npm test` | Vitest（D1 は `node:sqlite` のテスト用アダプタで代替する） |
| `npm run deploy` | typecheck と test が通ったときだけ `wrangler deploy` する |
| `npm run cf-typegen` | `wrangler types` で `worker-configuration.d.ts` を作り直す（binding を変えたら実行してコミット） |
| `npm run db:migrate:local` / `db:migrate:remote` | `migrations/` を適用する |
| `npm run report:checks` | `board_checks` の直近 50 行を表示する（`--remote` なので `database_id` 設定後のみ動く） |
| `npm run report:latency` | `scripts/latency-report.sql` で処理時間（空ボード 100ms / 非空 500ms の超過件数）を集計する（`--remote` なので `database_id` 設定後のみ動く） |

`npm run dev` にはローカル用の `.dev.vars`（Git に入れない）と、`npm run db:migrate:local` を適用したローカル D1 が必要。`.dev.vars` に置く環境変数名は `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `COOKIE_ENCRYPTION_KEY`（値は書き残さない）。

初回セットアップは [SETUP.md](./SETUP.md) を参照。

## claude.ai のユーザー設定に入れる指示文

接続後、claude.ai の個人設定（ユーザー設定の指示）の末尾に次をそのまま追記する。

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

サーバー側も同じ趣旨を `src/instructions.ts` の `SERVER_INSTRUCTIONS` として MCP の `instructions` で渡している。ユーザー設定の指示文はその補強で、両方あると遵守率が上がる。

# 初回セットアップ手順

絶対伝えろよリマインダーを Cloudflare にデプロイし、claude.ai のカスタムコネクタとして接続するまでの手順。上から順に実行する。

このファイルには秘密値そのものを書かない。書くのは環境変数名とコマンドだけ。`wrangler secret put` で貼り付けた値（`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `COOKIE_ENCRYPTION_KEY`）を、このファイルや他のドキュメント・Git に書き戻さないこと。

D1 の `database_id` と KV の `id` は秘密値ではなく Worker の設定値なので、手順 1・2 のとおり `wrangler.jsonc`（Git 管理下）に書いてコミットする。ドキュメントには書かない。

前提: Node 24 以上が入っていて `npm install` が済んでいること（テストが D1 を `node:sqlite` で代替するため、これより古い Node では `npm test` が動かず `npm run deploy` も通らない）。Cloudflare アカウントに `npx wrangler login` でログインしていること。

## 1. D1 データベースを作る

```sh
npx wrangler d1 create zettai-reminder --location <hint>
```

`<hint>` は location hint で、候補は `enam` / `wnam` / `apac`。どれにするかは SPIKE-001（空ボードの処理時間計測）の結果で決める。迷ったら `apac` で始めて、手順 9 のあと `npm run report:latency` を見て必要なら作り直す。

返ってきた `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に書く（プレースホルダ `00000000-0000-0000-0000-000000000000` を置き換える）。

## 2. KV 名前空間を作る

```sh
npx wrangler kv namespace create OAUTH_KV
```

返ってきた `id` を `wrangler.jsonc` の `kv_namespaces[0].id` に書く（プレースホルダを置き換える）。

## 3. GitHub OAuth App を作る

GitHub の Settings → Developer settings → OAuth Apps → New OAuth App。`<subdomain>` は Cloudflare の workers.dev サブドメイン。

- Homepage URL: `https://zettai-reminder-mcp.<subdomain>.workers.dev`
- Authorization callback URL: `https://zettai-reminder-mcp.<subdomain>.workers.dev/callback`

callback の経路は `src/auth/github-handler.ts` の実装どおり `/callback`（`new URL("/callback", request.url)` で組み立てて GitHub に渡し、`app.get("/callback")` で受ける）。

`wrangler.jsonc` の `vars.ALLOWED_GITHUB_USER_ID` が自分の GitHub ユーザー ID（数値）になっているか確認する。ここに一致しないユーザーは認可されない。ID は `https://api.github.com/users/<自分のログイン名>` の `id` で分かる。

## 4. secret を登録する

値はプロンプトに貼り付ける。ファイルに書かない。

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

`GITHUB_CLIENT_ID` と `GITHUB_CLIENT_SECRET` は手順 3 の OAuth App のもの（secret はその場で生成して 1 度だけ表示される）。`COOKIE_ENCRYPTION_KEY` は次で作った値を貼る。

```sh
openssl rand -hex 32
```

## 5. マイグレーションを適用する

```sh
npm run db:migrate:remote
```

## 6. デプロイする

```sh
npm run deploy
```

typecheck と test が通ったときだけ `wrangler deploy` が走る。

## 7. claude.ai にカスタムコネクタを追加する

claude.ai → 設定 → コネクタ → カスタムコネクタを追加。

- URL: `https://zettai-reminder-mcp.<subdomain>.workers.dev/mcp`

追加すると GitHub の認可画面に飛ぶので、手順 3 の OAuth App を承認する。`ALLOWED_GITHUB_USER_ID` と一致するユーザーでログインしていること。

## 8. ユーザー設定に指示文を追記する

claude.ai → 設定 → 個人設定（ユーザー設定の指示）の末尾に、次をそのまま追記する。

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

## 9. 動作を確認する

まず、Bearer トークン無しの `/mcp` が拒否されることを確認する（REQ-N004）。

```sh
curl -i https://zettai-reminder-mcp.<subdomain>.workers.dev/mcp
```

`401` が返ること。返らなければ公開状態なので、先に進まず `wrangler.jsonc` と手順 6 のデプロイを見直す。

次に claude.ai で新しい会話を始める。何か一言話しかけて、応答の前に `check_board` が呼ばれることを確認する（0 件なら応答にリマインダーの行は出ない）。

```sh
npm run report:checks
```

`board_checks` に 1 行増えていれば通っている。処理時間の集計は次で見る。

```sh
npm run report:latency
```

`bucket = empty` の `over_budget` が 0 のままなら、空ボードの目標（100ms 以内）を満たしている。増えるなら手順 1 の location hint を見直す。

ただし `duration_ms` は `check_board` が応答オブジェクトを組み立て終わるまでの時間で、Durable Object の起動・OAuth トークンの検証・MCP のトランスポート、および `board_checks` への INSERT は含まない。つまりクライアントの体感時間の下限であって、`over_budget = 0` は「サーバー内部の処理が予算内」を意味する。体感が遅いときは 0 のままでも location hint を疑う。

# 開発プロセス（PM 補完版・[Inferred]）

Stage 4 の開発プロセス書が未作成のため、PM が技術設計書（1〜4章）と要件定義書から補った。本人承認: 2026-09-27「PMが補って今すぐ実装」。
上流: 企画書 https://claude.ai/code/artifact/3b055bfe-98d2-4d4b-9a1c-e307925e7856 / 要件定義書 https://claude.ai/code/artifact/68102fe8-bd22-432b-8547-e71e9f88adeb / 技術設計書 https://claude.ai/code/artifact/886ee389-2b03-4b3e-a2db-edfcd13e8a1c（5〜11章は未記入）

## 共通バリデーション
`npm run typecheck` / `npm test` / `npx wrangler deploy --dry-run --outdir .wrangler/dry-run`

## Phase 1 — サーバー本体（ralphex: docs/plans/phase1-reminder-mcp.md）
- TASK-P1-001 土台（Worker・OAuth・McpAgent）
- TASK-P1-002 日時ユーティリティ
- TASK-P1-003 D1 スキーマとリポジトリ
- TASK-P1-004 MCP ツール 5 本（[Inferred] 技術設計書 5章の代替仕様）
- TASK-P1-005 運用ドキュメントと計測スクリプト

## Phase 2 — デプロイと接続（PM 直接実行・ralphex 外）
- TASK-P2-001 D1（location hint）・KV 作成、wrangler.jsonc へ ID 反映
- TASK-P2-002 GitHub OAuth App 作成（Claude in Chrome）・secret 設定
- TASK-P2-003 remote マイグレーション・デプロイ・未認証 401 確認
- TASK-P2-004 claude.ai カスタムコネクタ追加・ユーザー設定へ指示文追記（Claude in Chrome）
- TASK-P2-005 SPIKE-001: board_checks の duration_ms で空ボード 100ms を判定（未達なら DO 経由の影響を切り分け）

## Phase 3 — 実運用観察（SPIKE-002 / SPIKE-003、1〜2週間）
- 遵守率 95% 以上の観察（本人の受動記録＋参照記録の突き合わせ）

## 上流フィードバック
- DFB-001: 技術設計書 5〜11章が未記入。Phase 1 Task 4 の仕様を正として後から反映する（解決済み: Phase 1 Task 4 で実装。README.md のツール表が正）
- DFB-002: TEC-006 は流用元が McpAgent（DO 経由）と判明。REQ-N001 への影響を SPIKE-001 で測る
- DFB-003: 認証の上流 IdP は GitHub OAuth（ALLOWED_GITHUB_USER_ID で本人限定）。技術設計書 4.3 に明記が必要

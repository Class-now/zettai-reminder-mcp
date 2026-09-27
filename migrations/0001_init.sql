-- 絶対伝えろよリマインダー 初期スキーマ
--
-- 日時列はすべて `YYYY-MM-DDTHH:MM:SS+09:00`（日本時間固定）の文字列。全行で
-- オフセットが同じなので、文字列の辞書順比較がそのまま時刻順の比較になる。
--
-- 状態は列で持たない。show_at / archived_at / deleted_at と現在時刻の比較で決まる:
--   メインボード   archived_at IS NULL AND deleted_at IS NULL AND show_at <= :now
--   待機中         archived_at IS NULL AND deleted_at IS NULL AND show_at >  :now
--   アクティブ     archived_at IS NULL AND deleted_at IS NULL
--   アーカイブ済み archived_at IS NOT NULL AND deleted_at IS NULL

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

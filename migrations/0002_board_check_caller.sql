-- check_board の呼び出し元。claude.ai のチャット以外（Claude Code・Cowork など）から
-- 呼ばれてボードが消費されていないかを見分けるために記録する。NULL は記録前の行。
ALTER TABLE board_checks ADD COLUMN client TEXT;      -- initialize の clientInfo（name/version）
ALTER TABLE board_checks ADD COLUMN user_agent TEXT;  -- リクエストの User-Agent
ALTER TABLE board_checks ADD COLUMN session_id TEXT;  -- MCP のセッション ID

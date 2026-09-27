-- board_checks から check_board の処理時間を集計する（SPIKE-001 / REQ-N001 / REQ-N002）。
--
--   bucket      empty=空ボード（returned_count = 0）、non_empty=1 件以上返した回
--   checks      成功した呼び出し回数（ok = 1 だけを数える。失敗は分母に入れない）
--   avg_ms      duration_ms の平均（行が無ければ NULL）
--   max_ms      duration_ms の最大（行が無ければ NULL）
--   budget_ms   目標値。空ボード 100ms / 非空 500ms
--   over_budget budget_ms を超えた回数
--
-- duration_ms は check_board が応答オブジェクトを組み立て終わるまでの時間（プランの定義）。
-- Durable Object の起動・OAuth トークン検証・MCP トランスポート・この board_checks への
-- INSERT は含まないので、クライアントの体感時間の下限として読む。
--
-- さらに Workers では Date.now() が I/O をまたぐまで進まないので、duration_ms は実質
-- D1 の待ち時間だけを表し、並べ替えや整形の CPU 時間は乗らない。空ボードの avg_ms が
-- 0 に寄るのはこのため。CPU 時間まで見たいときは Workers Analytics を使う。
--
-- 1 文の SELECT（UNION ALL）なので --remote でも --local でもそのまま実行できる。
SELECT
  'empty' AS bucket,
  COUNT(*) AS checks,
  ROUND(AVG(duration_ms), 1) AS avg_ms,
  MAX(duration_ms) AS max_ms,
  100 AS budget_ms,
  COALESCE(SUM(CASE WHEN duration_ms > 100 THEN 1 ELSE 0 END), 0) AS over_budget
FROM board_checks
WHERE ok = 1 AND returned_count = 0
UNION ALL
SELECT
  'non_empty' AS bucket,
  COUNT(*) AS checks,
  ROUND(AVG(duration_ms), 1) AS avg_ms,
  MAX(duration_ms) AS max_ms,
  500 AS budget_ms,
  COALESCE(SUM(CASE WHEN duration_ms > 500 THEN 1 ELSE 0 END), 0) AS over_budget
FROM board_checks
WHERE ok = 1 AND returned_count > 0;

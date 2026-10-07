-- Per-place tournament prize receipts.
-- The legacy key `tournament:{id}` remains the idempotency marker for 1st place.
-- `:1`, `:2`, and `:3` record the exact 50/35/15 shares.

ALTER TABLE settlements DROP CONSTRAINT settlements_key_and_scope;

ALTER TABLE settlements ADD CONSTRAINT settlements_key_and_scope CHECK (
  (
    kind IN ('casual-win', 'casual-forfeit', 'casual-tie')
    AND room_id IS NOT NULL
    AND tournament_id IS NULL
    AND settlement_key = 'casual:' || room_id::text
  ) OR (
    kind = 'tournament-win'
    AND tournament_id IS NOT NULL
    AND room_id IS NULL
    AND (
      settlement_key = 'tournament:' || tournament_id::text
      OR settlement_key = 'tournament:' || tournament_id::text || ':1'
      OR settlement_key = 'tournament:' || tournament_id::text || ':2'
      OR settlement_key = 'tournament:' || tournament_id::text || ':3'
    )
  )
);

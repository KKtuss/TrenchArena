ALTER TABLE tournament_players
  DROP CONSTRAINT IF EXISTS tournament_players_status_check;

ALTER TABLE tournament_players
  ADD CONSTRAINT tournament_players_status_check
  CHECK (status IN ('registered', 'withdrawn', 'waitlisted'));

ALTER TABLE tournament_players
  ADD COLUMN IF NOT EXISTS burn_fee_paid BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS payment_ends_at TIMESTAMPTZ;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS payment_player_id TEXT;

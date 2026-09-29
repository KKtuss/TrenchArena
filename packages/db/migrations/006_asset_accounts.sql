-- Passport snapshots and on-chain balance mirrors (not the source of truth).
-- Chain balances remain authoritative; these rows support UI and gating audits.

CREATE TABLE passport_snapshots (
  id UUID PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  quote_id TEXT NOT NULL REFERENCES poke_quotes (quote_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  liquid_atoms BIGINT NOT NULL CHECK (liquid_atoms >= 0),
  held_entry_atoms BIGINT NOT NULL CHECK (held_entry_atoms >= 0),
  qualifying_atoms BIGINT NOT NULL CHECK (qualifying_atoms >= 0),
  usd_cents BIGINT NOT NULL CHECK (usd_cents >= 0),
  eligible BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX passport_snapshots_by_player
  ON passport_snapshots (player_id, created_at DESC);

CREATE TABLE chain_balance_mirrors (
  player_id TEXT NOT NULL REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  asset TEXT NOT NULL CHECK (asset IN ('SOL', 'POKE')),
  free_amount BIGINT NOT NULL CHECK (free_amount >= 0),
  held_amount BIGINT NOT NULL CHECK (held_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, asset)
);

ALTER TABLE casual_rooms
  DROP CONSTRAINT IF EXISTS casual_rooms_status_check;

ALTER TABLE casual_rooms
  ADD CONSTRAINT casual_rooms_status_check
  CHECK (status IN (
    'pending_deposit', 'open', 'full', 'ready', 'starting', 'battling', 'completed', 'cancelled'
  ));

ALTER TABLE casual_rooms
  ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT 'legacy_poke'
    CHECK (rail IN ('legacy_poke', 'sol_chain'));

ALTER TABLE casual_rooms
  ADD COLUMN IF NOT EXISTS collateral_lamports BIGINT
    CHECK (collateral_lamports IS NULL OR collateral_lamports > 0);

ALTER TABLE casual_rooms
  ADD COLUMN IF NOT EXISTS creator_deposit_intent_id UUID
    REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE casual_rooms
  ADD COLUMN IF NOT EXISTS opponent_deposit_intent_id UUID
    REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT 'legacy_poke'
    CHECK (rail IN ('legacy_poke', 'sol_chain'));

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS entry_atoms BIGINT
    CHECK (entry_atoms IS NULL OR entry_atoms >= 0);

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS entry_quote_id TEXT
    REFERENCES poke_quotes (quote_id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS prize_lamports BIGINT
    CHECK (prize_lamports IS NULL OR prize_lamports >= 0);

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS prize_reserve_intent_id UUID
    REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

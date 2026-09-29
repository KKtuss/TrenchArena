-- Tournament treasury ledger: realized SOL deposits split 90/10, plus prize reserves.

CREATE TABLE treasury_deposits (
  id UUID PRIMARY KEY,
  claim_key TEXT NOT NULL UNIQUE CHECK (char_length(claim_key) > 0),
  source TEXT NOT NULL DEFAULT 'creator_rewards'
    CHECK (source IN ('creator_rewards', 'manual_seed', 'other')),
  gross_lamports BIGINT NOT NULL CHECK (gross_lamports > 0),
  treasury_lamports BIGINT NOT NULL CHECK (treasury_lamports >= 0),
  operator_lamports BIGINT NOT NULL CHECK (operator_lamports >= 0),
  treasury_bps INTEGER NOT NULL CHECK (treasury_bps = 9000),
  operator_bps INTEGER NOT NULL CHECK (operator_bps = 1000),
  intent_id UUID REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  signature TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT treasury_deposits_split_sums
    CHECK (treasury_lamports + operator_lamports = gross_lamports)
);

CREATE TABLE prize_reserves (
  id UUID PRIMARY KEY,
  tournament_id UUID NOT NULL UNIQUE
    REFERENCES tournaments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  amount_lamports BIGINT NOT NULL CHECK (amount_lamports > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'paid', 'released')),
  reserve_intent_id UUID REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  settle_intent_id UUID REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  winner_id TEXT REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entry_escrows (
  id UUID PRIMARY KEY,
  tournament_id UUID NOT NULL
    REFERENCES tournaments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  player_id TEXT NOT NULL
    REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  amount_atoms BIGINT NOT NULL CHECK (amount_atoms > 0),
  quote_id TEXT NOT NULL REFERENCES poke_quotes (quote_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'burned', 'refunded')),
  deposit_intent_id UUID REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  terminal_intent_id UUID REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, player_id)
);

CREATE INDEX treasury_deposits_by_created ON treasury_deposits (created_at DESC);
CREATE INDEX entry_escrows_reserved ON entry_escrows (tournament_id) WHERE status = 'reserved';
CREATE INDEX prize_reserves_by_status ON prize_reserves (status);

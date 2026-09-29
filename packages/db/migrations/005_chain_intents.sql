-- Chain economy intents, quotes, and transaction receipts.
-- Legacy POKE wallets/holds/settlements are unchanged and must not be reinterpreted.

CREATE TABLE poke_quotes (
  quote_id TEXT PRIMARY KEY CHECK (char_length(quote_id) > 0),
  price_micro_usd BIGINT NOT NULL CHECK (price_micro_usd > 0),
  decimals INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 18),
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('env', 'mock', 'oracle', 'pyth', 'switchboard')),
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps >= 0 AND confidence_bps <= 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chain_intents (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'sol_wager_deposit',
    'sol_wager_refund',
    'sol_match_fee',
    'sol_match_win',
    'sol_match_tie',
    'poke_entry_deposit',
    'poke_entry_refund',
    'poke_entry_burn',
    'treasury_deposit',
    'prize_reserve',
    'prize_pay',
    'prize_release',
    'buyback_burn'
  )),
  scope_id TEXT NOT NULL CHECK (char_length(scope_id) > 0),
  player_id TEXT REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  asset TEXT NOT NULL CHECK (asset IN ('SOL', 'POKE')),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  quote_id TEXT REFERENCES poke_quotes (quote_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'created', 'pending', 'confirmed', 'failed', 'expired', 'cancelled'
  )),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) > 0),
  room_id UUID REFERENCES casual_rooms (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  tournament_id UUID REFERENCES tournaments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chain_intents_scope_kind UNIQUE (kind, scope_id)
);

CREATE TABLE chain_txs (
  id UUID PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES chain_intents (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  signature TEXT CHECK (signature IS NULL OR char_length(signature) > 0),
  slot BIGINT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'expired')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT chain_txs_signature_unique UNIQUE (signature)
);

CREATE INDEX chain_intents_by_status ON chain_intents (status) WHERE status IN ('created', 'pending');
CREATE INDEX chain_intents_by_room ON chain_intents (room_id) WHERE room_id IS NOT NULL;
CREATE INDEX chain_intents_by_tournament ON chain_intents (tournament_id) WHERE tournament_id IS NOT NULL;
CREATE INDEX chain_txs_by_intent ON chain_txs (intent_id);

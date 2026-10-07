-- Durable CARDS-only Pump creator-reward claim and sweep operations.
-- Private keys never belong in this table; signatures and reconciliation
-- metadata are sufficient to resume safely after an API restart.

CREATE TABLE creator_reward_operations (
  id UUID PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('claim_cards', 'sweep_cards')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'unknown', 'confirmed', 'failed')),
  signature TEXT UNIQUE,
  amount_raw BIGINT NOT NULL DEFAULT 0 CHECK (amount_raw >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX creator_reward_operations_open
  ON creator_reward_operations (created_at)
  WHERE status IN ('pending', 'unknown');

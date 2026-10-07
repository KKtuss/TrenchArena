-- Creator-reward CARDS stay in the creator wallet. This ledger records the
-- 90% tournament allocation and the 10% operator allocation, plus the amount
-- already reserved for tournaments. Private keys never belong here.

ALTER TABLE creator_reward_operations
  DROP CONSTRAINT IF EXISTS creator_reward_operations_kind_check;

ALTER TABLE creator_reward_operations
  ADD CONSTRAINT creator_reward_operations_kind_check
  CHECK (kind IN ('claim_cards', 'sweep_cards', 'fund_tournament'));

CREATE TABLE creator_reward_ledger (
  cards_mint TEXT PRIMARY KEY CHECK (char_length(cards_mint) > 0),
  gross_raw BIGINT NOT NULL CHECK (gross_raw >= 0),
  tournament_allocated_raw BIGINT NOT NULL CHECK (tournament_allocated_raw >= 0),
  operator_allocated_raw BIGINT NOT NULL CHECK (operator_allocated_raw >= 0),
  tournament_committed_raw BIGINT NOT NULL CHECK (tournament_committed_raw >= 0),
  CHECK (tournament_committed_raw <= tournament_allocated_raw),
  CHECK (tournament_allocated_raw + operator_allocated_raw = gross_raw),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE creator_reward_credits (
  operation_key TEXT PRIMARY KEY
    REFERENCES creator_reward_operations (operation_key),
  cards_mint TEXT NOT NULL,
  gross_raw BIGINT NOT NULL CHECK (gross_raw >= 0),
  tournament_raw BIGINT NOT NULL CHECK (tournament_raw >= 0),
  operator_raw BIGINT NOT NULL CHECK (operator_raw >= 0),
  CHECK (tournament_raw + operator_raw = gross_raw)
);

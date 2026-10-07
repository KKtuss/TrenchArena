-- Durable accounting for explicit operator claims from the creator-reward wallet.
-- The transfer is an ordinary CARDS SPL transfer signed by the creator signer;
-- no arena-program instruction is involved.

ALTER TABLE creator_reward_operations
  DROP CONSTRAINT IF EXISTS creator_reward_operations_kind_check;

ALTER TABLE creator_reward_operations
  ADD CONSTRAINT creator_reward_operations_kind_check
    CHECK (kind IN ('claim_cards', 'sweep_cards', 'fund_tournament', 'operator_claim'));

ALTER TABLE creator_reward_ledger
  ADD COLUMN IF NOT EXISTS operator_claimed_raw BIGINT NOT NULL DEFAULT 0
    CHECK (operator_claimed_raw >= 0);

ALTER TABLE creator_reward_ledger
  DROP CONSTRAINT IF EXISTS creator_reward_ledger_operator_claimed_check;

ALTER TABLE creator_reward_ledger
  ADD CONSTRAINT creator_reward_ledger_operator_claimed_check
    CHECK (operator_claimed_raw <= operator_allocated_raw);

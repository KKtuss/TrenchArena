-- Tournament prizes are denominated in raw CARDS atoms.
ALTER TABLE chain_intents
  DROP CONSTRAINT IF EXISTS chain_intents_kind_check;

ALTER TABLE chain_intents
  ADD CONSTRAINT chain_intents_kind_check CHECK (kind IN (
    'sol_wager_deposit', 'sol_wager_refund', 'sol_match_fee', 'sol_match_win',
    'sol_match_tie', 'poke_entry_deposit', 'poke_entry_refund', 'poke_entry_burn',
    'treasury_deposit', 'prize_reserve', 'prize_pay', 'prize_release',
    'buyback_burn', 'cards_prize_fund', 'cards_prize_pay', 'cards_prize_release'
  ));

ALTER TABLE chain_intents
  DROP CONSTRAINT IF EXISTS chain_intents_asset_check;

ALTER TABLE chain_intents
  ADD CONSTRAINT chain_intents_asset_check CHECK (asset IN ('SOL', 'POKE', 'CARDS'));

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS prize_cards_raw BIGINT
  CHECK (prize_cards_raw IS NULL OR prize_cards_raw > 0);

ALTER TABLE chain_balance_mirrors
  DROP CONSTRAINT IF EXISTS chain_balance_mirrors_asset_check;

ALTER TABLE chain_balance_mirrors
  ADD CONSTRAINT chain_balance_mirrors_asset_check
  CHECK (asset IN ('SOL', 'POKE', 'CARDS'));

ALTER TABLE prize_reserves
  ALTER COLUMN amount_lamports DROP NOT NULL;

ALTER TABLE prize_reserves
  ADD COLUMN IF NOT EXISTS prize_cards_raw BIGINT
  CHECK (prize_cards_raw IS NULL OR prize_cards_raw > 0);


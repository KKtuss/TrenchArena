-- Batch 6D: tournament registration remains in-memory until 6E.
-- Tournament entry holds and tournament-win settlements must persist as
-- economics without a parent tournaments row. Casual room FKs stay intact.

ALTER TABLE holds DROP CONSTRAINT holds_tournament_id_fkey;
ALTER TABLE settlements DROP CONSTRAINT settlements_tournament_id_fkey;

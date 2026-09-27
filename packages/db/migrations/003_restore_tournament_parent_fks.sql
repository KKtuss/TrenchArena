-- Batch 6E: tournament rows are now persisted. Restore the parent foreign
-- keys that 002 dropped so 6D could store tournament entry holds first.
--
-- Development and test databases may contain 6D leftover holds/settlements
-- whose tournament_id does not exist. Delete those orphans, then re-add
-- the constraints. Do not add the FKs first — existing orphans would fail
-- the migration.

DELETE FROM holds
WHERE purpose = 'tournament_entry'
  AND tournament_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tournaments AS t WHERE t.id = holds.tournament_id
  );

DELETE FROM settlements
WHERE kind = 'tournament-win'
  AND tournament_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tournaments AS t WHERE t.id = settlements.tournament_id
  );

ALTER TABLE holds
  ADD CONSTRAINT holds_tournament_id_fkey
  FOREIGN KEY (tournament_id) REFERENCES tournaments (id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE settlements
  ADD CONSTRAINT settlements_tournament_id_fkey
  FOREIGN KEY (tournament_id) REFERENCES tournaments (id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

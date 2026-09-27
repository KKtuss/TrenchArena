-- Batch 6F: live Showdown matches cannot be restored after a process crash.
-- Persist an explicit `interrupted` status so recovery never overloads
-- `tied`, `completed`, or `ready` to mean "the simulator is gone".
-- `interrupted` has no winner and no fabricated result. startMatch may
-- resume from it the same way it resumes from `tied`.

ALTER TABLE tournament_matches DROP CONSTRAINT tournament_matches_status_check;
ALTER TABLE tournament_matches DROP CONSTRAINT tournament_matches_status_winner;
ALTER TABLE tournament_matches DROP CONSTRAINT tournament_matches_tied_is_not_permanently_terminal;

ALTER TABLE tournament_matches
  ADD CONSTRAINT tournament_matches_status_check
  CHECK (status IN (
    'pending', 'ready', 'battle-created', 'active', 'completed', 'forfeited', 'tied', 'interrupted'
  ));

ALTER TABLE tournament_matches
  ADD CONSTRAINT tournament_matches_status_winner
  CHECK (
    (status IN ('pending', 'ready', 'battle-created', 'active') AND winner_id IS NULL)
    OR (status IN ('completed', 'forfeited') AND winner_id IS NOT NULL)
    OR (status IN ('tied', 'interrupted') AND winner_id IS NULL)
  );

ALTER TABLE tournament_matches
  ADD CONSTRAINT tournament_matches_tied_is_not_permanently_terminal
  CHECK (status <> 'tied' OR completed_at IS NOT NULL);

ALTER TABLE tournament_matches
  ADD CONSTRAINT tournament_matches_interrupted_records_crash
  CHECK (status <> 'interrupted' OR completed_at IS NOT NULL);

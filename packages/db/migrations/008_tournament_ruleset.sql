ALTER TABLE tournaments
  ADD COLUMN ruleset TEXT NOT NULL DEFAULT 'gen9ou';

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_ruleset_known;

ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_ruleset_known
  CHECK (ruleset IN (
    'gen9ou',
    'gen1cup', 'gen2cup', 'gen3cup', 'gen4cup', 'gen5cup', 'gen6cup', 'gen7cup', 'gen8cup', 'gen9cup',
    'gen1casual', 'gen2casual', 'gen3casual', 'gen4casual', 'gen5casual', 'gen6casual', 'gen7casual', 'gen8casual', 'gen9casual'
  ));

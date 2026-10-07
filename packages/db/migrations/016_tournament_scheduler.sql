-- Durable, one-shot tournament scheduler state and scheduled-start idempotency.

CREATE TABLE tournament_scheduler (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  next_tournament_start_at TIMESTAMPTZ,
  next_rotation_index BIGINT NOT NULL DEFAULT 0 CHECK (next_rotation_index >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tournament_scheduler (id, enabled, next_tournament_start_at, next_rotation_index)
VALUES (1, false, NULL, 0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE tournaments ADD COLUMN scheduled_key TEXT;
CREATE UNIQUE INDEX tournaments_scheduled_key_unique
  ON tournaments (scheduled_key)
  WHERE scheduled_key IS NOT NULL;

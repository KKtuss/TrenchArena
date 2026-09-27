-- PokeArena durable schema (Batch 6B).
-- Integer POKE uses BIGINT (no floating-point). Application Number.isInteger
-- values fit BIGINT; node-pg returns BIGINT as string (Batch 6C concern).

CREATE TABLE wallets (
  player_id TEXT PRIMARY KEY CHECK (char_length(player_id) > 0),
  balance BIGINT NOT NULL CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE casual_rooms (
  id UUID PRIMARY KEY,
  match_id TEXT NOT NULL UNIQUE,
  room_type TEXT NOT NULL CHECK (room_type IN ('private', 'open')),
  battle_size TEXT NOT NULL CHECK (battle_size IN ('1v1', '2v2')),
  format TEXT NOT NULL CHECK (format = 'gen9ou'),
  creator_id TEXT NOT NULL REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  opponent_id TEXT REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  invited_player_id TEXT REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  collateral BIGINT NOT NULL CHECK (collateral > 0),
  status TEXT NOT NULL CHECK (status IN (
    'open', 'full', 'ready', 'starting', 'battling', 'completed', 'cancelled'
  )),
  winner_id TEXT REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  result_status TEXT CHECK (result_status IN ('win', 'tie')),
  battle_instance_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT casual_rooms_match_id_matches_id
    CHECK (match_id = 'casual-' || id::text),
  CONSTRAINT casual_rooms_open_has_no_opponent
    CHECK (status <> 'open' OR opponent_id IS NULL),
  CONSTRAINT casual_rooms_winner_only_when_completed
    CHECK (winner_id IS NULL OR status = 'completed'),
  CONSTRAINT casual_rooms_result_only_when_completed
    CHECK (result_status IS NULL OR status = 'completed'),
  CONSTRAINT casual_rooms_completed_has_opponent
    CHECK (status <> 'completed' OR opponent_id IS NOT NULL),
  CONSTRAINT casual_rooms_completed_at_when_terminal
    CHECK (
      (status IN ('completed', 'cancelled') AND completed_at IS NOT NULL)
      OR (status NOT IN ('completed', 'cancelled') AND completed_at IS NULL)
    )
);

CREATE TABLE tournaments (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) > 0),
  format TEXT NOT NULL CHECK (format = 'gen9ou'),
  max_players INTEGER NOT NULL CHECK (max_players IN (4, 8, 16, 32)),
  bracket_seed TEXT NOT NULL,
  match_timeout_ms INTEGER NOT NULL CHECK (match_timeout_ms > 0),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'registration', 'ready', 'in-progress', 'completed', 'cancelled'
  )),
  host_id TEXT NOT NULL REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  entry_fee BIGINT NOT NULL CHECK (entry_fee >= 0),
  winner_id TEXT REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT tournaments_winner_only_when_completed
    CHECK (winner_id IS NULL OR status = 'completed'),
  CONSTRAINT tournaments_completed_at_when_completed
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL AND winner_id IS NOT NULL)
      OR (status <> 'completed')
    )
);

CREATE TABLE tournament_players (
  tournament_id UUID NOT NULL REFERENCES tournaments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  player_id TEXT NOT NULL REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  display_name TEXT NOT NULL CHECK (char_length(display_name) > 0),
  team TEXT NOT NULL CHECK (char_length(team) > 0 AND char_length(team) <= 12000),
  eligible BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL CHECK (status IN ('registered', 'withdrawn')),
  registration_order INTEGER NOT NULL CHECK (registration_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, player_id),
  UNIQUE (tournament_id, registration_order)
);

ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_winner_is_player
  FOREIGN KEY (id, winner_id)
  REFERENCES tournament_players (tournament_id, player_id)
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

CREATE TABLE tournament_matches (
  id UUID PRIMARY KEY,
  tournament_id UUID NOT NULL REFERENCES tournaments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  round INTEGER NOT NULL CHECK (round >= 1),
  bracket_position INTEGER NOT NULL CHECK (bracket_position >= 0),
  player1_id TEXT,
  player2_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'ready', 'battle-created', 'active', 'completed', 'forfeited', 'tied'
  )),
  battle_instance_id TEXT,
  winner_id TEXT,
  result_kind TEXT CHECK (result_kind IN ('battle', 'forfeit')),
  result_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (tournament_id, round, bracket_position),
  FOREIGN KEY (tournament_id, player1_id)
    REFERENCES tournament_players (tournament_id, player_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tournament_id, player2_id)
    REFERENCES tournament_players (tournament_id, player_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tournament_id, winner_id)
    REFERENCES tournament_players (tournament_id, player_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tournament_matches_status_winner
    CHECK (
      (status IN ('pending', 'ready', 'battle-created', 'active') AND winner_id IS NULL)
      OR (status IN ('completed', 'forfeited') AND winner_id IS NOT NULL)
      OR (status = 'tied' AND winner_id IS NULL)
    ),
  CONSTRAINT tournament_matches_tied_is_not_permanently_terminal
    CHECK (status <> 'tied' OR completed_at IS NOT NULL)
);

CREATE TABLE holds (
  hold_key TEXT PRIMARY KEY CHECK (char_length(hold_key) > 0),
  player_id TEXT NOT NULL REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  amount BIGINT NOT NULL CHECK (amount > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('casual_creator', 'casual_opponent', 'tournament_entry')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'released', 'consumed')),
  room_id UUID REFERENCES casual_rooms (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  tournament_id UUID REFERENCES tournaments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminal_at TIMESTAMPTZ,
  CONSTRAINT holds_one_terminal_status
    CHECK (status IN ('reserved', 'released', 'consumed')),
  CONSTRAINT holds_terminal_timestamp
    CHECK (
      (status = 'reserved' AND terminal_at IS NULL)
      OR (status IN ('released', 'consumed') AND terminal_at IS NOT NULL)
    ),
  CONSTRAINT holds_purpose_references
    CHECK (
      (
        purpose IN ('casual_creator', 'casual_opponent')
        AND room_id IS NOT NULL
        AND tournament_id IS NULL
      ) OR (
        purpose = 'tournament_entry'
        AND tournament_id IS NOT NULL
        AND room_id IS NULL
      )
    ),
  CONSTRAINT holds_key_matches_purpose
    CHECK (
      (purpose = 'casual_creator' AND hold_key = 'casual:' || room_id::text || ':creator')
      OR (purpose = 'casual_opponent' AND hold_key = 'casual:' || room_id::text || ':opponent')
      OR (purpose = 'tournament_entry' AND hold_key = 'tournament:' || tournament_id::text || ':' || player_id)
    )
);

CREATE UNIQUE INDEX holds_one_creator_per_room
  ON holds (room_id)
  WHERE purpose = 'casual_creator';

CREATE UNIQUE INDEX holds_one_opponent_per_room
  ON holds (room_id)
  WHERE purpose = 'casual_opponent';

CREATE UNIQUE INDEX holds_one_entry_per_player
  ON holds (tournament_id, player_id)
  WHERE purpose = 'tournament_entry';

CREATE TABLE settlements (
  settlement_key TEXT PRIMARY KEY CHECK (char_length(settlement_key) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('casual-win', 'casual-forfeit', 'casual-tie', 'tournament-win')),
  winner_id TEXT REFERENCES wallets (player_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  protocol_fee BIGINT CHECK (protocol_fee >= 0),
  room_id UUID REFERENCES casual_rooms (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  tournament_id UUID REFERENCES tournaments (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settlements_key_and_scope
    CHECK (
      (
        kind IN ('casual-win', 'casual-forfeit', 'casual-tie')
        AND room_id IS NOT NULL
        AND tournament_id IS NULL
        AND settlement_key = 'casual:' || room_id::text
      ) OR (
        kind = 'tournament-win'
        AND tournament_id IS NOT NULL
        AND room_id IS NULL
        AND settlement_key = 'tournament:' || tournament_id::text
      )
    ),
  CONSTRAINT settlements_winner_by_kind
    CHECK (
      (kind = 'casual-tie' AND winner_id IS NULL)
      OR (kind IN ('casual-win', 'casual-forfeit', 'tournament-win') AND winner_id IS NOT NULL)
    ),
  CONSTRAINT settlements_fee_by_kind
    CHECK (
      (kind IN ('casual-win', 'casual-forfeit') AND protocol_fee IS NOT NULL)
      OR (kind = 'casual-tie' AND protocol_fee = 0)
      OR (kind = 'tournament-win' AND protocol_fee IS NULL)
    )
);

CREATE UNIQUE INDEX settlements_one_per_room
  ON settlements (room_id)
  WHERE room_id IS NOT NULL;

CREATE UNIQUE INDEX settlements_one_per_tournament
  ON settlements (tournament_id)
  WHERE tournament_id IS NOT NULL;

ALTER TABLE casual_rooms
  ADD COLUMN settlement_key TEXT UNIQUE REFERENCES settlements (settlement_key)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX holds_reserved_by_player
  ON holds (player_id)
  WHERE status = 'reserved';

CREATE INDEX holds_reserved_by_room
  ON holds (room_id)
  WHERE status = 'reserved' AND room_id IS NOT NULL;

CREATE INDEX holds_reserved_by_tournament
  ON holds (tournament_id)
  WHERE status = 'reserved' AND tournament_id IS NOT NULL;

CREATE INDEX casual_rooms_nonterminal
  ON casual_rooms (status)
  WHERE status NOT IN ('completed', 'cancelled');

CREATE INDEX casual_rooms_creator
  ON casual_rooms (creator_id);

CREATE INDEX tournaments_by_status
  ON tournaments (status);

CREATE INDEX tournament_matches_by_tournament
  ON tournament_matches (tournament_id, round, bracket_position);

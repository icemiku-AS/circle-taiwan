CREATE TABLE rooms (
 id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, creation_key TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'lobby', game_id TEXT, round_id TEXT, round_index INTEGER NOT NULL DEFAULT 0,
 start_at INTEGER, deadline INTEGER, settings TEXT NOT NULL, questions TEXT NOT NULL, versions TEXT NOT NULL,
 plan_version INTEGER NOT NULL DEFAULT 1, metadata_version INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 expires_at INTEGER NOT NULL
);
CREATE INDEX rooms_expiry ON rooms(expires_at);
CREATE TABLE room_players (
 room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL, token TEXT NOT NULL,
 join_key TEXT NOT NULL, name TEXT NOT NULL, seat INTEGER NOT NULL CHECK(seat BETWEEN 0 AND 7),
 ready INTEGER NOT NULL DEFAULT 0, loaded_version INTEGER NOT NULL DEFAULT 0,
 in_game INTEGER NOT NULL DEFAULT 0, left INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(room_id,id), UNIQUE(room_id,join_key), UNIQUE(room_id,seat)
);
CREATE TABLE room_answers (
 room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, game_id TEXT NOT NULL, round_id TEXT NOT NULL,
 round_index INTEGER NOT NULL, player_id TEXT NOT NULL, submission_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ok','invalid','unanswered','calculation_failed','forced_missing')),
 score REAL, elapsed REAL NOT NULL, points TEXT,
 PRIMARY KEY(room_id,game_id,round_id,player_id)
);

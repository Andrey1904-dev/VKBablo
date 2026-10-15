-- Additive hardening for local SQLite mode: durable worker claims, one-time
-- owner setup fields, character reference selection, and AI budget reservations.

ALTER TABLE characters
  ADD COLUMN appearance_status TEXT NOT NULL DEFAULT 'placeholder'
  CHECK (appearance_status IN ('placeholder', 'approved'));

ALTER TABLE characters ADD COLUMN primary_reference_id TEXT;
ALTER TABLE character_references
  ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0
  CHECK (is_primary IN (0, 1));
CREATE UNIQUE INDEX idx_character_references_primary
  ON character_references(character_id) WHERE is_primary = 1;

ALTER TABLE jobs ADD COLUMN lock_token TEXT;

ALTER TABLE ai_generations ADD COLUMN budget_reservation_id TEXT;
CREATE UNIQUE INDEX idx_ai_generations_budget_reservation
  ON ai_generations(budget_reservation_id) WHERE budget_reservation_id IS NOT NULL;

CREATE TABLE ai_budget_reservations (
  id TEXT PRIMARY KEY,
  month_start TEXT NOT NULL,
  reserved_usd REAL NOT NULL CHECK (reserved_usd > 0),
  actual_usd REAL NOT NULL DEFAULT 0 CHECK (actual_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_ai_budget_reservations_active
  ON ai_budget_reservations(month_start, status);

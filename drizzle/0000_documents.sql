CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL UNIQUE,
  guest_token TEXT NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner TEXT NOT NULL CHECK (owner IN ('alex', 'maya')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_shares (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL CHECK (recipient IN ('alex', 'maya')),
  PRIMARY KEY (document_id, recipient)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_id, updated_at DESC);

ALTER TABLE documents ADD COLUMN edited_by TEXT;
--> statement-breakpoint
CREATE TABLE document_presence (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, user_id)
);
--> statement-breakpoint
CREATE TABLE document_comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX document_comments_order ON document_comments(document_id, created_at);
--> statement-breakpoint
CREATE TABLE document_versions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, revision)
);
--> statement-breakpoint
CREATE TRIGGER record_document_version AFTER UPDATE OF title, content ON documents
WHEN NEW.file_name IS NULL AND (OLD.title <> NEW.title OR OLD.content <> NEW.content)
BEGIN
  INSERT INTO document_versions VALUES
    (OLD.id, OLD.revision, OLD.title, OLD.content, COALESCE(OLD.edited_by, OLD.owner), OLD.updated_at)
    ON CONFLICT(document_id, revision) DO NOTHING;
  INSERT INTO document_versions VALUES
    (NEW.id, NEW.revision, NEW.title, NEW.content, COALESCE(NEW.edited_by, NEW.owner), NEW.updated_at)
    ON CONFLICT(document_id, revision) DO NOTHING;
  DELETE FROM document_versions WHERE document_id = NEW.id AND revision IN (
    SELECT revision FROM document_versions WHERE document_id = NEW.id ORDER BY revision DESC LIMIT -1 OFFSET 50
  );
END;

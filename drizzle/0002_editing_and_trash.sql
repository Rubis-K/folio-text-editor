ALTER TABLE document_shares ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor'));
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN object_key TEXT;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN purge_started INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX documents_trash_expiry ON documents(deleted_at) WHERE deleted_at IS NOT NULL;

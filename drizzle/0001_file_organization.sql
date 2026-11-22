ALTER TABLE documents ADD COLUMN folder TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN link_token TEXT;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN file_name TEXT;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN file_type TEXT;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN file_size INTEGER;
--> statement-breakpoint
CREATE UNIQUE INDEX documents_link_token ON documents(link_token) WHERE link_token IS NOT NULL;

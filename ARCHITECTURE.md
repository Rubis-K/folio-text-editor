## Editor and storage
Folio uses a native HTML editor with rich-text formatting and autosave. PDF import converts selectable text into editable content. Exports run in the browser and support PDF, TXT, and Word-compatible DOC. The same API runs on Node.js locally and Cloudflare Workers in production. Local development uses SQLite and the filesystem. Production uses D1 for records and private R2 storage for uploads.

## Sharing and collaboration
The server enforces owner, editor, and viewer permissions. Owners can revoke public read-only links independently of account grants. Shared documents show active collaborators and support document-level comments.

Revision checks prevent stale saves from overwriting newer edits. History keeps up to 50 text revisions, and restoring an earlier revision creates a new one. Trash items remain recoverable for 30 days.

## Tradeoffs
Demo accounts simplify review. For production, I’d prioritize real authentication, expiring share links, and better recovery for conflicting edits.
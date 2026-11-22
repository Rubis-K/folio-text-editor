# Folio

Folio is a small collaborative document editor for drafting, saving, and sharing a document for review.

## Run locally

Requires Node.js 24 or later. Install the pinned PDF import and export dependencies. The local app needs no API keys or external accounts.

```sh
npm ci --omit=optional
npm run dev
```

Open [localhost:3000](http://localhost:3000). Use `PORT` to change the port, `FOLIO_DB` for a different SQLite path, or `FOLIO_FILES` for a different upload directory. By default the server migrates `.data/folio.sqlite` on startup and stores uploaded bytes in `.data/files/`.

```sh
npm test
npm run build
```

The tests run the same request handlers used in production against SQLite. The build creates the Worker bundle in `dist/server/index.js` and the hosting configuration in `dist/.openai/`. The hosted deployment declares D1 as `DB` and R2 as `BUCKET` and applies the migration from `drizzle/`.

## Reviewer flow

1. Open the live app. The browser creates an isolated demo workspace and opens as **Alex Morgan**. It includes two owned documents and a sample shared by **Maya Chen**. No credentials are needed.
2. Choose **New document**, replace the title, and type in the editor. Select text and use the toolbar for formatting or to choose one of seven text sizes. Click **Save**, or wait for **Saved**, then reload to confirm the document reopens.
3. Open **Share** and choose **View only** or **Can edit**, then grant access to Maya. Close the dialog and use the account switch next to Alex's name. As Maya, open the new document under **Shared with you**. Maya can read or edit and save according to the selected role. Only Alex can organize or share it.
4. Switch back to Alex. In **Share**, choose **Create link** and **Copy link**. Open the URL in a private browser window. It opens this item for viewing without an account. Use **Disable link** to revoke link access. Demo account grants have their own controls.
5. Choose **Upload file**. Select [Launch-QA.txt](examples/Launch-QA.txt) or use your own UTF-8 `.txt` file up to 128 KB to create an editable document. PDF, DOCX, PNG, and JPEG files can be up to 10 MB. Uploading a PDF with selectable text creates an editable document with reconstructed paragraphs and headings, up to 100 pages. Scan-only pages require OCR outside Folio. Complex layouts may be simplified. PNGs open on a canvas with pixel editing tools for images up to 16 megapixels. DOCX and JPEG uploads keep their original format.
6. Choose **Move to folder** to move an item into an existing or new folder. The sidebar arrows collapse and expand each folder. **No folder** returns the item to the top-level list.
7. **Move to Trash** sits beside **Save** and asks for confirmation. Trash shows the days remaining in the 30-day retention period and provides **Restore** and **Delete permanently**. Permanent deletion also asks for confirmation.

The account switch is available in the browser that created the workspace. Restoring an item reinstates its demo account grants. The owner must create a new public link after a restore.

## Download and collaborate

- **Save** writes to Folio. **Export** beside it downloads the current editor content as PDF, UTF-8 TXT, or a Word-compatible HTML `.doc`. Word may show a format warning for the HTML document. PDF keeps text selectable and preserves common formatting.
- Shared items are marked in the sidebar and beside the document title. To try live presence, open the same workspace in two tabs, switch one to the other demo account, and open a document shared between them. Active collaborators appear within a few seconds.
- **Comments** opens a document-wide discussion. Owners and editors can post, and signed-in viewers can read comments.
- **History** shows up to 50 saved text revisions, including the current state. Owners and editors can preview revisions, and owners can restore one as a new revision.

## Scope

Owners can create, rename, format, reopen, upload, organize, and share items. Shared documents are read-only. Live text merging, inline suggestions, enhanced conflict recovery, OCR for scanned PDFs, and editable DOCX conversion were deferred.

See [ARCHITECTURE.md](ARCHITECTURE.md), [AI-WORKFLOW.md](AI-WORKFLOW.md), and [SUBMISSION.md](SUBMISSION.md).

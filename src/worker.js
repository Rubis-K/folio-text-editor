const PEOPLE = {
  alex: { id: 'alex', name: 'Alex Morgan', initials: 'AM' },
  maya: { id: 'maya', name: 'Maya Chen', initials: 'MC' },
};
const EMPTY = '<p><br></p>';
const MAX_IMPORT = 128 * 1024;
const TRASH_RETENTION = 30 * 86_400_000;
const MAX_FILE = 10 * 1024 * 1024;
const DOCUMENT_FILES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
const MAX_CONTENT = 768 * 1024;
const MAX_BODY = 1024 * 1024;
const VALID_ID = /^[a-f0-9-]{36}$/;
const STARTER = '<h1>Spring launch brief</h1><p>A shared plan for the product launch. Use this space to align on what we’re shipping, who owns each decision, and what still needs review.</p><h2>Goals</h2><ul><li>Give the team one source of truth for launch decisions.</li><li>Make the first release easy to explain and easy to try.</li></ul><h2>Next steps</h2><ol><li>Confirm the launch scope with the product team.</li><li>Share the first draft with Maya for review.</li></ol><p><strong>Open question:</strong> What should we show in the first customer demo?</p>';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const statement = (db, sql, ...params) => db.prepare(sql).bind(...params);
const escapeHtml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function safeMarkup(html) {
  // Font size is the sole supported attribute and uses a fixed set of values.
  const tags = /<\/?(?:p|div|br|strong|b|em|i|u|h1|h2|h3|ul|ol|li|blockquote)>|<font size="[1-7]">|<\/font>/gi;
  let result = '';
  let previous = 0;
  for (const match of html.matchAll(tags)) {
    result += html.slice(previous, match.index).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    result += match[0].toLowerCase();
    previous = match.index + match[0].length;
  }
  return result + html.slice(previous).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new HttpError(415, 'Send the request as JSON.');
  }
  if (!request.body) throw new HttpError(400, 'A JSON object is required.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let raw = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new HttpError(413, 'The request is too large.');
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch (error) {
    if (error instanceof HttpError) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
  throw new HttpError(400, 'A valid JSON object is required.');
}

function titleOf(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new HttpError(400, 'Enter a title between 1 and 100 characters.');
  }
  return title;
}

async function identify(request, db) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9-]{36})$/)?.[1];
  if (!token) throw new HttpError(401, 'Open a demo workspace first.');
  const row = await statement(db, 'SELECT * FROM workspaces WHERE owner_token = ? OR guest_token = ?', token, token).first();
  if (!row) throw new HttpError(401, 'This workspace session is no longer available.');
  return { workspace: row.id, user: token === row.owner_token ? 'alex' : 'maya' };
}

function newDocument(workspace, owner, title, content) {
  return { id: crypto.randomUUID(), workspace_id: workspace, owner, title, content, updated_at: Date.now(), revision: 1 };
}

function insertDocument(db, doc) {
  return statement(db, 'INSERT INTO documents (id, workspace_id, owner, title, content, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    doc.id, doc.workspace_id, doc.owner, doc.title, doc.content, doc.updated_at);
}

function view(doc, user) {
  return {
    id: doc.id, title: doc.title, owner: PEOPLE[doc.owner],
    updatedAt: doc.updated_at, revision: doc.revision,
    access: doc.owner === user ? 'owner' : doc.share_role || 'viewer',
    ...(doc.owner === user ? { folder: doc.folder || '', trashed: doc.deleted_at !== null && doc.deleted_at !== undefined, expiresAt: doc.deleted_at == null ? null : doc.deleted_at + TRASH_RETENTION } : {}),
    shared: Boolean(doc.has_grants || doc.has_link || (user && doc.owner !== user)),
    sharedByLink: Boolean(doc.has_link),
    file: doc.file_name ? { name: doc.file_name, type: doc.file_type, size: doc.file_size } : null,
    ...(doc.content === undefined ? {} : { content: doc.content }),
  };
}

async function createWorkspace(db) {
  const id = crypto.randomUUID();
  const alex = crypto.randomUUID();
  const maya = crypto.randomUUID();
  const brief = newDocument(id, 'alex', 'Spring launch brief', STARTER);
  const notes = newDocument(id, 'alex', 'Team meeting notes', '<h1>Team meeting notes</h1><p>Capture decisions, open questions, and follow-ups here.</p>');
  const plan = newDocument(id, 'maya', 'Research plan', '<h1>Research plan</h1><p>Let’s interview five people who regularly draft and review shared documents.</p>');
  await db.batch([
    statement(db, 'INSERT INTO workspaces (id, owner_token, guest_token) VALUES (?, ?, ?)', id, alex, maya),
    insertDocument(db, brief), insertDocument(db, notes), insertDocument(db, plan),
    statement(db, 'INSERT INTO document_shares (document_id, recipient) VALUES (?, ?)', plan.id, 'alex'),
  ]);
  return json({ tokens: { alex, maya }, initialDocument: brief.id }, 201);
}

const documentAccess = `LEFT JOIN document_shares AS s ON s.document_id = d.id AND s.recipient = ?
  WHERE d.workspace_id = ? AND d.purge_started = 0 AND
  ((d.owner = ? AND (d.deleted_at IS NULL OR d.deleted_at > ?)) OR
    (d.deleted_at IS NULL AND s.role IS NOT NULL))`;

const sharingFields = `EXISTS (SELECT 1 FROM document_shares AS grants WHERE grants.document_id = d.id) AS has_grants,
  d.link_token IS NOT NULL AS has_link`;

async function allowedDocument(db, session, id) {
  const doc = await statement(db, `SELECT d.*, s.role AS share_role, ${sharingFields} FROM documents AS d
    ${documentAccess} AND d.id = ?`, session.user, session.workspace, session.user, Date.now() - TRASH_RETENTION, id).first();
  if (!doc) throw new HttpError(404, 'This document could not be found or you do not have access.');
  return doc;
}

async function listDocuments(db, session) {
  const { results } = await statement(db, `SELECT d.id, d.owner, d.title, d.updated_at, d.revision, d.folder, d.deleted_at,
    d.file_name, d.file_type, d.file_size, s.role AS share_role, ${sharingFields} FROM documents AS d
    ${documentAccess} ORDER BY d.updated_at DESC, d.rowid`,
  session.user, session.workspace, session.user, Date.now() - TRASH_RETENTION).all();
  return json({ user: PEOPLE[session.user], documents: results.map((doc) => view(doc, session.user)) });
}

async function createDocument(request, db, session, importing) {
  const data = await readBody(request);
  let content = EMPTY;
  let title = data.title === undefined ? 'Untitled document' : titleOf(data.title);
  if (importing === 'pdf') {
    title = titleOf(data.title);
    if (typeof data.content !== 'string' || !data.content.trim()) throw new HttpError(400, 'No editable text was found in this PDF.');
    content = checkedContent(data.content);
  } else if (importing) {
    if (typeof data.name !== 'string' || !/\.txt$/i.test(data.name) || typeof data.text !== 'string') {
      throw new HttpError(400, 'Choose a UTF-8 .txt file.');
    }
    if (new TextEncoder().encode(data.text).byteLength > MAX_IMPORT) {
      throw new HttpError(413, 'Text files must be 128 KB or smaller.');
    }
    if (data.text.includes('\0')) throw new HttpError(400, 'Choose a plain text file.');
    title = titleOf(data.name.split(/[\\/]/).at(-1).slice(0, -4).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100).trim() || 'Imported document');
    const lines = data.text.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
    content = '<p>' + lines.map(escapeHtml).join('<br>') + '</p>';
    if (content === '<p></p>') content = EMPTY;
  }
  const doc = newDocument(session.workspace, session.user, title, content);
  await insertDocument(db, doc).run();
  return json(view(doc, session.user), 201);
}

function checkedContent(markup) {
  const content = safeMarkup(markup) || EMPTY;
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT) throw new HttpError(413, 'This document is too large to save.');
  return content;
}

const editableDocument = `WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?
  AND (owner = ? OR EXISTS (SELECT 1 FROM document_shares
    WHERE document_id = documents.id AND recipient = ? AND role = 'editor'))`;

function editorParams(doc, session, revision) {
  return [doc.id, session.workspace, revision, session.user, session.user];
}

async function editDocument(request, db, session, doc) {
  const data = await readBody(request);
  const title = titleOf(data.title);
  if ((!doc.file_name && typeof data.content !== 'string') || !Number.isSafeInteger(data.revision) || data.revision < 1) {
    throw new HttpError(400, 'Content and a valid document revision are required.');
  }
  const content = doc.file_name ? EMPTY : checkedContent(data.content);
  const updatedAt = Date.now();
  const result = await statement(db, `UPDATE documents SET title = ?, content = ?, updated_at = ?, edited_by = ?, revision = revision + 1
    ${editableDocument} RETURNING id`, title, content, updatedAt, session.user, ...editorParams(doc, session, data.revision)).first();
  if (!result) throw new HttpError(409, 'This item changed or your access was updated. Reload to continue.');
  return json(view(await allowedDocument(db, session, doc.id), session.user));
}

async function sharing(request, db, session, doc) {
  const recipient = session.user === 'alex' ? 'maya' : 'alex';
  if (request.method === 'PUT') {
    const data = await readBody(request);
    if (data.recipient !== recipient) throw new HttpError(400, 'Choose the other demo account.');
    const role = data.role ?? 'viewer';
    if (!['viewer', 'editor'].includes(role)) throw new HttpError(400, 'Choose View only or Can edit.');
    await statement(db, `INSERT INTO document_shares (document_id, recipient, role)
      VALUES (?, ?, ?) ON CONFLICT(document_id, recipient) DO UPDATE SET role = excluded.role`, doc.id, recipient, role).run();
  }
  if (request.method === 'DELETE') {
    await statement(db, 'DELETE FROM document_shares WHERE document_id = ? AND recipient = ?', doc.id, recipient).run();
  }
  const grant = await statement(db, 'SELECT role FROM document_shares WHERE document_id = ? AND recipient = ?', doc.id, recipient).first();
  const token = grant && recipient === 'maya' ? await statement(db, 'SELECT guest_token FROM workspaces WHERE id = ?', session.workspace).first() : null;
  return json({ recipient: PEOPLE[recipient], granted: Boolean(grant), role: grant?.role ?? null, guestToken: token?.guest_token ?? null });
}

function fileTitle(name) {
  return titleOf(name.slice(0, name.lastIndexOf('.')).slice(0, 100).trim() || 'Uploaded file');
}

async function readFile(request) {
  if (!request.body) throw new HttpError(400, 'Choose a file to upload.');
  if (Number(request.headers.get('content-length')) > MAX_FILE) {
    throw new HttpError(413, 'Files must be 10 MB or smaller.');
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'Files must be 10 MB or smaller.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function matchesFile(ext, bytes) {
  const starts = (...signature) => signature.every((value, index) => bytes[index] === value);
  if (ext === 'pdf') return starts(37, 80, 68, 70, 45);
  if (ext === 'png') return starts(137, 80, 78, 71, 13, 10, 26, 10);
  if (ext === 'jpg' || ext === 'jpeg') return starts(255, 216, 255);
  // A DOCX is a ZIP package. Check its signature and Word package entries without expanding it.
  if (!starts(80, 75, 3, 4)) return false;
  const packageText = new TextDecoder('latin1').decode(bytes);
  return packageText.includes('[Content_Types].xml') && packageText.includes('word/document.xml');
}

async function uploadFile(request, db, bucket, session) {
  const original = new URL(request.url).searchParams.get('name') || '';
  const name = original.split(/[\\/]/).at(-1).trim();
  const ext = name.split('.').at(-1).toLowerCase();
  if (!name.includes('.') || !Object.hasOwn(DOCUMENT_FILES, ext)) {
    throw new HttpError(415, 'Choose a PDF, DOCX, PNG, or JPEG file.');
  }
  if (name.length > 180 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, 'Choose a file with a valid name under 180 characters.');
  }
  const bytes = await readFile(request);
  if (!matchesFile(ext, bytes)) throw new HttpError(400, 'The file content does not match its extension.');
  const doc = newDocument(session.workspace, session.user, fileTitle(name), EMPTY);
  doc.file_name = name;
  doc.file_type = DOCUMENT_FILES[ext];
  doc.file_size = bytes.byteLength;
  await bucket.put(doc.id, bytes);
  try {
    await statement(db, `INSERT INTO documents
      (id, workspace_id, owner, title, content, updated_at, file_name, file_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    doc.id, doc.workspace_id, doc.owner, doc.title, doc.content, doc.updated_at,
    doc.file_name, doc.file_type, doc.file_size).run();
  } catch (error) {
    // Keep the object on ambiguous database failures to avoid breaking a committed record.
    try {
      const saved = await statement(db, 'SELECT id FROM documents WHERE id = ?', doc.id).first();
      if (!saved) await bucket.delete(doc.id);
    } catch (cleanupError) {
      console.error(cleanupError);
    }
    throw error;
  }
  return json(view(doc, session.user), 201);
}

async function downloadFile(bucket, doc) {
  if (!doc.file_name) throw new HttpError(404, 'There is no uploaded file for this item.');
  const file = await bucket.get(doc.object_key || doc.id);
  if (!file) throw new HttpError(404, 'This file is unavailable.');
  const name = encodeURIComponent(doc.file_name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16));
  return new Response(file.body, { headers: {
    'Content-Type': doc.file_type,
    'Content-Length': String(doc.file_size),
    'Content-Disposition': "attachment; filename*=UTF-8''" + name,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

async function moveDocument(request, db, session, doc) {
  const { folder } = await readBody(request);
  if (typeof folder !== 'string' || folder.trim().length > 50 || /[\u0000-\u001f\u007f]/.test(folder)) {
    throw new HttpError(400, 'Enter a folder name up to 50 characters.');
  }
  const result = await statement(db, 'UPDATE documents SET folder = ? WHERE id = ? AND deleted_at IS NULL',
    folder.trim(), doc.id).run();
  if (!result.meta.changes) throw new HttpError(409, 'The item could not be moved.');
  return json(view(await allowedDocument(db, session, doc.id), session.user));
}

async function setTrash(db, session, doc, trashed) {
  const change = trashed
    ? 'SET deleted_at = ?, link_token = NULL, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL'
    : 'SET deleted_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at > ? AND purge_started = 0';
  const bindings = trashed ? [Date.now(), doc.id] : [null, doc.id, Date.now() - TRASH_RETENTION];
  await statement(db, 'UPDATE documents ' + change, ...bindings).run();
  return json(view(await allowedDocument(db, session, doc.id), session.user));
}

async function purgeDocument(db, bucket, id, cutoff = Date.now()) {
  const claim = await statement(db, `UPDATE documents SET purge_started = 1
    WHERE id = ? AND deleted_at <= ? RETURNING id, file_name, object_key`, id, cutoff).first();
  if (!claim) return false;
  if (claim.file_name) await bucket.delete(claim.object_key || claim.id);
  await statement(db, 'DELETE FROM documents WHERE id = ? AND purge_started = 1', id).run();
  return true;
}

export async function purgeExpired({ DB: db, BUCKET: bucket }) {
  const cutoff = Date.now() - TRASH_RETENTION;
  const { results } = await statement(db, `SELECT id FROM documents
    WHERE deleted_at <= ? OR purge_started = 1 ORDER BY purge_started, deleted_at LIMIT 20`, cutoff).all();
  let purged = 0;
  let failed = 0;
  for (const { id } of results) {
    try {
      if (await purgeDocument(db, bucket, id, Date.now())) purged++;
    } catch (error) {
      failed++;
      console.error(error);
    }
  }
  return { purged, failed, remainingBatch: results.length === 20 };
}

async function editPng(request, db, bucket, session, doc) {
  if (doc.file_type !== 'image/png') throw new HttpError(415, 'This image is not a PNG.');
  const revision = Number(new URL(request.url).searchParams.get('revision'));
  if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpError(400, 'A valid image revision is required.');
  const bytes = await readFile(request);
  if (!matchesFile('png', bytes)) throw new HttpError(400, 'Choose a valid PNG image.');
  const key = crypto.randomUUID();
  const updatedAt = Date.now();
  await bucket.put(key, bytes);
  try {
    const saved = await statement(db, `UPDATE documents SET file_size = ?, object_key = ?, updated_at = ?, revision = revision + 1
      ${editableDocument} RETURNING *`, bytes.byteLength, key, updatedAt, ...editorParams(doc, session, revision)).first();
    if (!saved) throw new HttpError(409, 'This image changed or your access was updated. Reload to continue.');
    await bucket.delete(doc.object_key || doc.id).catch(console.error);
    return json(view({ ...saved, share_role: doc.share_role, has_grants: doc.has_grants, has_link: doc.has_link }, session.user));
  } catch (error) {
    try {
      const exists = await statement(db, 'SELECT id FROM documents WHERE object_key = ?', key).first();
      if (!exists) await bucket.delete(key);
    } catch (cleanupError) {
      console.error(cleanupError);
    }
    throw error;
  }
}

async function manageLink(request, db, doc) {
  if (request.method === 'PUT') {
    const token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '');
    await statement(db, 'UPDATE documents SET link_token = COALESCE(link_token, ?) WHERE id = ? AND deleted_at IS NULL',
      token, doc.id).run();
  }
  if (request.method === 'DELETE') {
    await statement(db, 'UPDATE documents SET link_token = NULL WHERE id = ?', doc.id).run();
  }
  const row = await statement(db, 'SELECT link_token FROM documents WHERE id = ? AND deleted_at IS NULL', doc.id).first();
  return json({ token: row?.link_token ?? null });
}

async function readShared(request, db, bucket, path) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const doc = token && await statement(db,
    'SELECT * FROM documents WHERE link_token = ? AND deleted_at IS NULL', token).first();
  if (!doc) throw new HttpError(404, 'This shared link is unavailable. Ask the owner for a current link.');
  if (path === '/api/shared/file') return downloadFile(bucket, doc);
  return json(view(doc));
}

async function presence(db, session, doc) {
  const now = Date.now();
  await statement(db, `INSERT INTO document_presence (document_id, user_id, seen_at) VALUES (?, ?, ?)
    ON CONFLICT(document_id, user_id) DO UPDATE SET seen_at = excluded.seen_at`, doc.id, session.user, now).run();
  const { results } = await statement(db, `SELECT user_id FROM document_presence
    WHERE document_id = ? AND user_id <> ? AND seen_at > ? AND (
      user_id = ? OR EXISTS (SELECT 1 FROM document_shares AS s WHERE s.document_id = ? AND s.recipient = user_id)
    )`, doc.id, session.user, now - 16_000, doc.owner, doc.id).all();
  return json({
    people: results.map(({ user_id }) => PEOPLE[user_id]).filter(Boolean),
    shared: Boolean(doc.has_grants || doc.has_link || doc.owner !== session.user),
    access: doc.owner === session.user ? 'owner' : doc.share_role,
  });
}

async function comments(request, db, session, doc) {
  if (request.method === 'POST') {
    if (doc.owner !== session.user && doc.share_role !== 'editor') throw new HttpError(403, 'View-only recipients cannot comment.');
    const data = await readBody(request);
    const text = typeof data.body === 'string' ? data.body.trim() : '';
    if (!text || text.length > 1000) throw new HttpError(400, 'Enter a comment of 1 to 1,000 characters.');
    const createdAt = Date.now();
    const id = crypto.randomUUID();
    const result = await statement(db, `INSERT INTO document_comments (id, document_id, author, body, created_at)
      SELECT ?, id, ?, ?, ? FROM documents WHERE id = ? AND deleted_at IS NULL AND (owner = ? OR
      EXISTS (SELECT 1 FROM document_shares WHERE document_id = documents.id AND recipient = ? AND role = 'editor'))`,
    id, session.user, text, createdAt, doc.id, session.user, session.user).run();
    if (!result.meta.changes) throw new HttpError(403, 'You no longer have permission to comment.');
    return json({ id, author: PEOPLE[session.user], body: text, createdAt }, 201);
  }
  const { results } = await statement(db, `SELECT id, author, body, created_at FROM document_comments
    WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`, doc.id).all();
  return json(results.reverse().map((row) => ({
    id: row.id, author: PEOPLE[row.author], body: row.body, createdAt: row.created_at,
  })));
}

async function versions(request, db, session, doc) {
  if (doc.file_name) throw new HttpError(415, 'Version history is available for text documents.');
  if (doc.owner !== session.user && doc.share_role !== 'editor') throw new HttpError(403, 'Version history requires edit access.');
  const url = new URL(request.url);
  if (request.method === 'PUT') {
    if (doc.owner !== session.user) throw new HttpError(403, 'Only the owner can restore a version.');
    const { revision, currentRevision } = await readBody(request);
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(currentRevision)) throw new HttpError(400, 'Choose a valid version.');
    const old = await statement(db, 'SELECT title, content FROM document_versions WHERE document_id = ? AND revision = ?', doc.id, revision).first();
    if (!old) throw new HttpError(404, 'This version is no longer available.');
    const result = await statement(db, `UPDATE documents SET title = ?, content = ?, updated_at = ?, edited_by = ?, revision = revision + 1
      WHERE id = ? AND owner = ? AND deleted_at IS NULL AND revision = ? RETURNING id`,
    old.title, old.content, Date.now(), session.user, doc.id, session.user, currentRevision).first();
    if (!result) throw new HttpError(409, 'This document changed. Reopen history and try again.');
    return json(view(await allowedDocument(db, session, doc.id), session.user));
  }
  if (url.searchParams.has('revision')) {
    const revision = Number(url.searchParams.get('revision'));
    const row = revision === doc.revision ? doc : await statement(db, 'SELECT title, content FROM document_versions WHERE document_id = ? AND revision = ?', doc.id, revision).first();
    if (!row) throw new HttpError(404, 'This version is no longer available.');
    return json({ title: row.title, content: row.content });
  }
  const { results } = await statement(db, `SELECT revision, title, author, created_at FROM document_versions
    WHERE document_id = ? AND revision < ? AND (title <> ? OR content <> ? OR revision <> COALESCE(
      (SELECT max(revision) FROM document_versions WHERE document_id = ?), 0))
    ORDER BY revision DESC LIMIT 49`, doc.id, doc.revision, doc.title, doc.content, doc.id).all();
  const current = { revision: doc.revision, title: doc.title, author: doc.edited_by || doc.owner, created_at: doc.updated_at };
  return json([current, ...results].map((row) => ({
    revision: row.revision, title: row.title, author: PEOPLE[row.author], createdAt: row.created_at,
  })));
}

async function api(request, { DB: db, BUCKET: bucket }, path, context) {
  if (path === '/api/workspaces' && request.method === 'POST') return createWorkspace(db);
  if (request.method === 'GET' && (path === '/api/shared' || path === '/api/shared/file')) {
    return readShared(request, db, bucket, path);
  }
  const session = await identify(request, db);
  if (path === '/api/documents') {
    if (request.method === 'GET') {
      const cleanup = purgeExpired({ DB: db, BUCKET: bucket }).catch(console.error);
      if (context?.waitUntil) context.waitUntil(cleanup);
      else await cleanup;
      return listDocuments(db, session);
    }
    if (request.method === 'POST') return createDocument(request, db, session, false);
  }
  if (path === '/api/uploads' && request.method === 'POST') return uploadFile(request, db, bucket, session);
  if (path === '/api/import-pdf' && request.method === 'POST') return createDocument(request, db, session, 'pdf');
  if (path === '/api/import' && request.method === 'POST') return createDocument(request, db, session, true);
  const [, resource, collection, id, action, extra] = path.split('/');
  if (resource !== 'api' || collection !== 'documents' || !VALID_ID.test(id || '') || extra) {
    throw new HttpError(404, 'That endpoint does not exist.');
  }
  const doc = await allowedDocument(db, session, id);
  if (!action && request.method === 'GET') return json(view(doc, session.user));
  if (!doc.deleted_at && action === 'file' && request.method === 'GET') return downloadFile(bucket, doc);
  if (!doc.deleted_at && request.method === 'PUT' && (doc.owner === session.user || doc.share_role === 'editor')) {
    if (!action) return editDocument(request, db, session, doc);
    if (action === 'image') return editPng(request, db, bucket, session, doc);
  }
  if (!doc.deleted_at) {
    if (action === 'presence' && request.method === 'POST') return presence(db, session, doc);
    if (action === 'comments' && ['GET', 'POST'].includes(request.method)) return comments(request, db, session, doc);
    if (action === 'versions' && ['GET', 'PUT'].includes(request.method)) return versions(request, db, session, doc);
  }
  if (doc.owner !== session.user) throw new HttpError(403, 'Only the owner can edit or manage access.');
  if (!action && request.method === 'DELETE') return setTrash(db, session, doc, true);
  if (action === 'purge' && request.method === 'DELETE' && doc.deleted_at !== null) {
    return json({ deleted: await purgeDocument(db, bucket, doc.id) });
  }
  if (action === 'restore' && request.method === 'PUT') return setTrash(db, session, doc, false);
  if (doc.deleted_at) throw new HttpError(409, 'Restore this item from Trash first.');
  if (action === 'move' && request.method === 'PUT') return moveDocument(request, db, session, doc);
  if (action === 'link' && ['GET', 'PUT', 'DELETE'].includes(request.method)) return manageLink(request, db, doc);
  if (action === 'share' && ['GET', 'PUT', 'DELETE'].includes(request.method)) return sharing(request, db, session, doc);
  throw new HttpError(405, 'This action is not supported.');
}

function serveVideo(request, bytes) {
  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=300',
  });
  const range = request.headers.get('range');
  let start = 0;
  let end = bytes.byteLength - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (match && Number(match[2]) > 0) {
      start = Math.max(0, bytes.byteLength - Number(match[2]));
    } else {
      start = bytes.byteLength;
    }
    if (start >= bytes.byteLength || end < start) {
      headers.set('Content-Range', 'bytes */' + bytes.byteLength);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  const body = request.method === 'HEAD' ? null : bytes.subarray(start, end + 1);
  return new Response(body, { status: range ? 206 : 200, headers });
}

export function createApp(assets = {}) {
  const pages = {
    '/': ['index.html', 'text/html'],
    '/style.css': ['style.css', 'text/css'],
    '/app.js': ['app.js', 'text/javascript'],
    '/shared': ['shared.html', 'text/html'],
    '/shared.js': ['shared.js', 'text/javascript'],
    '/file-preview.js': ['file-preview.js', 'text/javascript'],
    '/export.js': ['export.js', 'text/javascript'],
    '/pdfmake.min.js': ['pdfmake.min.js', 'text/javascript'],
    '/pdfmake-fonts.js': ['pdfmake-fonts.js', 'text/javascript'],
    '/png-editor.js': ['png-editor.js', 'text/javascript'],
    '/pdf-import.js': ['pdf-import.js', 'text/javascript'],
    '/pdf.min.mjs': ['pdf.min.mjs', 'text/javascript'],
    '/pdf.worker.min.mjs': ['pdf.worker.min.mjs', 'text/javascript'],
    '/walkthrough': ['walkthrough.html', 'text/html'],
    '/walkthrough.vtt': ['walkthrough.vtt', 'text/vtt'],
  };
  let videoBytes;
  return async (request, env, context) => {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/maintenance/purge-trash' && request.method === 'POST') return json(await purgeExpired(env));
      if (pathname.startsWith('/api/')) return await api(request, env, pathname, context);
      if (pathname === '/walkthrough.mp4' && assets['walkthrough.mp4']) {
        const asset = assets['walkthrough.mp4'];
        videoBytes ??= typeof asset === 'function' ? asset() : Uint8Array.from(atob(asset), (char) => char.charCodeAt(0));
        return serveVideo(request, videoBytes);
      }
      if (!Object.hasOwn(pages, pathname)) return new Response('Not found', { status: 404 });
      const [key, type] = pages[pathname];
      const html = typeof assets[key] === 'function' ? assets[key]() : assets[key];
      return new Response(request.method === 'HEAD' ? null : html, { headers: {
        'Content-Type': type + '; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; img-src blob:; font-src 'self'; base-uri 'none'; form-action 'self'",
      } });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'The workspace is temporarily unavailable. Try again in a moment.' }, 500);
    }
  };
}

export default {
  fetch: createApp(typeof ASSETS === 'undefined' ? {} : ASSETS),
  scheduled(_event, env, context) { context.waitUntil(purgeExpired(env)); },
};

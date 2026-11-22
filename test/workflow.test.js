import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/worker.js';
import { openDatabase } from '../scripts/database.mjs';
import { openFiles } from '../scripts/files.mjs';

function client(database, bucket) {
  const app = createApp();
  return async (method, path, token, body) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const binary = body instanceof Uint8Array;
    if (body !== undefined && !binary) headers['Content-Type'] = 'application/json';
    const response = await app(new Request('http://localhost/api' + path, {
      method, headers, body: binary || body === undefined ? body : JSON.stringify(body),
    }), { DB: database, BUCKET: bucket });
    const data = response.headers.get('content-type').includes('application/json')
      ? await response.json()
      : new Uint8Array(await response.arrayBuffer());
    return { status: response.status, data };
  };
}

test('owner creates, renames and shares a formatted document that persists across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-test-'));
  const file = join(directory, 'test.sqlite');
  let db = openDatabase(file);
  try {
    let request = client(db);
    const { data: { tokens } } = await request('POST', '/workspaces');
    const create = await request('POST', '/documents', tokens.alex, {});
    assert.equal(create.status, 201);
    const path = '/documents/' + create.data.id;
    const content = '<h1>Agenda</h1><ul><li><b>Bold</b> <i>italic</i> <u>underline</u></li></ul>';
    const update = { title: 'Review agenda', content, revision: create.data.revision };
    assert.equal((await request('GET', path, tokens.maya)).status, 404);
    assert.equal((await request('PUT', path, tokens.alex, update)).status, 200);
    assert.equal((await request('PUT', path, tokens.alex, update)).status, 409);
    assert.equal((await request('PUT', path + '/share', tokens.alex, { recipient: 'maya' })).status, 200);

    db.close();
    db = openDatabase(file);
    request = client(db);
    const received = await request('GET', path, tokens.maya);
    assert.equal(received.status, 200);
    assert.equal(received.data.title, 'Review agenda');
    assert.equal(received.data.content, content);
    assert.equal(received.data.access, 'viewer');
    const { data: { documents } } = await request('GET', '/documents', tokens.maya);
    assert.equal(documents.find((doc) => doc.id === create.data.id).access, 'viewer');
    assert.equal((await request('PUT', path, tokens.maya, update)).status, 403);
    assert.equal((await request('DELETE', path + '/share', tokens.maya)).status, 403);
    const { data: another } = await request('POST', '/workspaces');
    assert.equal((await request('GET', path, another.tokens.alex)).status, 404);
    assert.equal((await request('DELETE', path + '/share', tokens.alex)).status, 200);
    assert.equal((await request('GET', path, tokens.maya)).status, 404);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('text import validates type and size, preserves line breaks, and neutralizes markup', async () => {
  const db = openDatabase();
  try {
    const request = client(db);
    const { data: { tokens } } = await request('POST', '/workspaces');
    const text = 'Line one\r\n<img src=x onerror=alert(1)> & more';
    assert.equal((await request('POST', '/import', tokens.alex, { name: 'Brief.docx', text })).status, 400);
    assert.equal((await request('POST', '/import', tokens.alex, { name: 'Brief.txt', text: 'x'.repeat(131073) })).status, 413);
    const imported = await request('POST', '/import', tokens.alex, { name: 'Brief.txt', text });
    assert.equal(imported.status, 201);
    assert.equal(imported.data.title, 'Brief');
    assert.equal(imported.data.content, '<p>Line one<br>&lt;img src=x onerror=alert(1)&gt; &amp; more</p>');
    const unsafe = await request('PUT', '/documents/' + imported.data.id, tokens.alex, {
      title: 'Brief', content: '<p><span onclick="alert(1)">Hi</span><u>There</u></p>', revision: 1,
    });
    assert.equal(unsafe.data.content, '<p>&lt;span onclick="alert(1)"&gt;Hi&lt;/span&gt;<u>There</u></p>');
  } finally {
    db.close();
  }
});

test('uploaded files survive a move and only their owner can move or delete them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-files-'));
  const db = openDatabase(join(directory, 'db.sqlite'));
  try {
    const api = client(db, openFiles(join(directory, 'files')));
    const { data: { tokens } } = await api('POST', '/workspaces');
    const pdf = new TextEncoder().encode('%PDF-1.7\nDemo\n%%EOF');
    const invalid = new TextEncoder().encode('Some text');
    assert.equal((await api('POST', '/uploads?name=brief.exe', tokens.alex, pdf)).status, 415);
    assert.equal((await api('POST', '/uploads?name=brief.pdf', tokens.alex, invalid)).status, 400);
    const { status, data: item } = await api('POST', '/uploads?name=brief.pdf', tokens.alex, pdf);
    assert.equal(status, 201);
    assert.equal(item.file.name, 'brief.pdf');
    assert.equal(item.file.size, pdf.byteLength);
    const path = '/documents/' + item.id;
    const response = await api('PUT', path + '/move', tokens.alex, { folder: 'Reference' });
    assert.equal(response.data.folder, 'Reference');
    assert.deepEqual((await api('GET', path + '/file', tokens.alex)).data, pdf);
    assert.equal((await api('PUT', path, tokens.alex, { title: 'Reference brief', revision: item.revision })).data.title, 'Reference brief');
    await api('PUT', path + '/share', tokens.alex, { recipient: 'maya' });
    assert.equal((await api('PUT', path + '/move', tokens.maya, { folder: 'Denied' })).status, 403);
    assert.equal((await api('DELETE', path, tokens.maya)).status, 403);
    assert.equal((await api('PUT', path + '/link', tokens.maya)).status, 403);
    const { data: { token } } = await api('PUT', path + '/link', tokens.alex);
    assert.deepEqual((await api('GET', '/shared/file', token)).data, pdf);
    assert.equal((await api('DELETE', path, tokens.alex)).data.trashed, true);
    assert.equal((await api('GET', path, tokens.maya)).status, 404);
    assert.equal((await api('GET', '/shared/file', token)).status, 404);
    const list = await api('GET', '/documents', tokens.alex);
    assert.equal(list.data.documents.find((doc) => doc.id === item.id).trashed, true);
    assert.equal((await api('PUT', path + '/restore', tokens.alex)).data.folder, 'Reference');
    assert.deepEqual((await api('GET', path + '/file', tokens.maya)).data, pdf);
    assert.equal((await api('GET', '/shared', token)).status, 404);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a link opens a single item without a demo account and can be rotated', async () => {
  const db = openDatabase();
  try {
    const api = client(db);
    const { data: { tokens, initialDocument } } = await api('POST', '/workspaces');
    const path = '/documents/' + initialDocument + '/link';
    const { data: { token } } = await api('PUT', path, tokens.alex);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal((await api('PUT', path, tokens.alex)).data.token, token);
    const shared = await api('GET', '/shared', token);
    assert.equal(shared.data.id, initialDocument);
    assert.equal(shared.data.access, 'viewer');
    assert.equal((await api('GET', '/documents', token)).status, 401);
    assert.equal((await api('DELETE', path, tokens.alex)).data.token, null);
    assert.equal((await api('GET', '/shared', token)).status, 404);
    assert.notEqual((await api('PUT', path, tokens.alex)).data.token, token);
  } finally {
    db.close();
  }
});

test('opening a version-one database preserves existing documents and grants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-migrate-'));
  const file = join(directory, 'db.sqlite');
  const old = new DatabaseSync(file);
  const id = '71b1a179-fe2a-4825-88b4-eaece9281e64';
  const maya = 'c1159469-80c2-461e-9d26-0fd0db0b80b4';
  old.exec(readFileSync(new URL('../drizzle/0000_documents.sql', import.meta.url), 'utf8'));
  old.prepare('INSERT INTO workspaces (id, owner_token, guest_token) VALUES (?, ?, ?)').run('legacy', 'legacy-owner', maya);
  old.prepare('INSERT INTO documents (id, workspace_id, owner, title, content, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'legacy', 'alex', 'Legacy document', '<h2>Saved heading</h2>', 1);
  old.prepare('INSERT INTO document_shares (document_id, recipient) VALUES (?, ?)').run(id, 'maya');
  old.close();
  const db = openDatabase(file);
  try {
    const response = await client(db)('GET', '/documents/' + id, maya);
    assert.equal(response.status, 200);
    assert.equal(response.data.content, '<h2>Saved heading</h2>');
    assert.equal(response.data.file, null);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('editor grants allow saves and font sizes, and downgrading blocks writes', async () => {
  const db = openDatabase();
  try {
    const api = client(db);
    const { data: { tokens, initialDocument } } = await api('POST', '/workspaces');
    const path = '/documents/' + initialDocument;
    assert.equal((await api('PUT', path + '/share', tokens.alex, { recipient: 'maya', role: 'editor' })).data.role, 'editor');
    const markup = '<p><font size="6">Large</font> <font size="1">Tiny</font></p>';
    const edited = await api('PUT', path, tokens.maya, { revision: 1, title: 'Edited by Maya', content: markup });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.content, markup);
    assert.equal((await api('GET', path, tokens.alex)).data.content, markup);
    assert.equal((await api('PUT', path + '/move', tokens.maya, { folder: 'Denied' })).status, 403);
    await api('PUT', path + '/share', tokens.alex, { recipient: 'maya', role: 'viewer' });
    assert.equal((await api('GET', path, tokens.maya)).data.access, 'viewer');
    assert.equal((await api('PUT', path, tokens.maya, { revision: 2, title: 'Denied', content: markup })).status, 403);
  } finally {
    db.close();
  }
});

test('the latest saved PNG persists and permanent deletion removes its stored bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-png-'));
  const db = openDatabase();
  try {
    const files = openFiles(directory);
    const api = client(db, files);
    const { data: { tokens } } = await api('POST', '/workspaces');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSaUAAAAASUVORK5CYII=', 'base64');
    const { data: item } = await api('POST', '/uploads?name=dot.png', tokens.alex, png);
    const path = '/documents/' + item.id;
    const saved = await api('PUT', path + '/image?revision=1', tokens.alex, png);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.revision, 2);
    assert.equal((await api('PUT', path + '/image?revision=1', tokens.alex, png)).status, 409);
    assert.deepEqual((await api('GET', path + '/file', tokens.alex)).data, new Uint8Array(png));
    const row = await db.prepare('SELECT object_key FROM documents WHERE id = ?').bind(item.id).first();
    assert.ok(await files.get(row.object_key));
    assert.equal(await files.get(item.id), null);
    assert.equal((await api('DELETE', path + '/purge', tokens.alex)).status, 405);
    await api('DELETE', path, tokens.alex);
    assert.equal((await api('DELETE', path + '/purge', tokens.alex)).data.deleted, true);
    assert.equal(await files.get(row.object_key), null);
    assert.equal((await api('GET', path, tokens.alex)).status, 404);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('expired Trash entries are purged while newer items remain restorable', async () => {
  const db = openDatabase();
  try {
    const api = client(db);
    const { data: { tokens } } = await api('POST', '/workspaces');
    const { data: oldItem } = await api('POST', '/import-pdf', tokens.alex, {
      title: 'Reconstructed PDF', content: '<h2>Heading</h2><p>Editable text</p>',
    });
    assert.equal(oldItem.content, '<h2>Heading</h2><p>Editable text</p>');
    const { data: newItem } = await api('POST', '/documents', tokens.alex, {});
    const trash = await api('DELETE', '/documents/' + newItem.id, tokens.alex);
    assert.ok(trash.data.expiresAt > Date.now() + 29 * 86_400_000);
    await db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?')
      .bind(Date.now() - 31 * 86_400_000, oldItem.id).run();
    assert.equal((await api('PUT', '/documents/' + oldItem.id + '/restore', tokens.alex)).status, 404);
    const cleanup = await api('POST', '/maintenance/purge-trash');
    assert.equal(cleanup.data.purged, 1);
    assert.equal(await db.prepare('SELECT id FROM documents WHERE id = ?').bind(oldItem.id).first(), null);
    assert.equal((await api('PUT', '/documents/' + newItem.id + '/restore', tokens.alex)).data.trashed, false);
  } finally {
    db.close();
  }
});

test('sharing indicators, presence, comments, and revision history respect access', async () => {
  const db = openDatabase();
  try {
    const run = client(db);
    const { data: { tokens, initialDocument } } = await run('POST', '/workspaces');
    const path = '/documents/' + initialDocument;
    assert.equal((await run('GET', path, tokens.alex)).data.shared, false);
    await run('PUT', path + '/share', tokens.alex, { recipient: 'maya', role: 'editor' });
    assert.equal((await run('GET', path, tokens.alex)).data.shared, true);
    assert.deepEqual((await run('POST', path + '/presence', tokens.alex)).data.people, []);
    assert.equal((await run('POST', path + '/presence', tokens.maya)).data.people[0].id, 'alex');
    assert.equal((await run('POST', path + '/presence', tokens.alex)).data.people[0].id, 'maya');

    const change = await run('PUT', path, tokens.maya, { title: 'Edited together', content: '<p>New text</p>', revision: 1 });
    assert.equal(change.data.revision, 2);
    const list = await run('GET', path + '/versions', tokens.alex);
    assert.deepEqual(list.data.map((item) => [item.revision, item.author.id]), [[2, 'maya'], [1, 'alex']]);
    const original = await run('GET', path + '/versions?revision=1', tokens.alex);
    assert.equal(original.data.title, 'Spring launch brief');
    assert.equal((await run('PUT', path + '/versions', tokens.maya, { revision: 1, currentRevision: 2 })).status, 403);
    const restored = await run('PUT', path + '/versions', tokens.alex, { revision: 1, currentRevision: 2 });
    assert.equal(restored.data.revision, 3);
    assert.equal(restored.data.content, original.data.content);
    assert.equal((await run('GET', path + '/versions?revision=2', tokens.alex)).data.content, '<p>New text</p>');

    const posted = await run('POST', path + '/comments', tokens.maya, { body: ' Ready for review. ' });
    assert.equal(posted.status, 201);
    assert.equal((await run('GET', path + '/comments', tokens.alex)).data[0].body, 'Ready for review.');
    await run('PUT', path + '/share', tokens.alex, { recipient: 'maya', role: 'viewer' });
    assert.equal((await run('POST', path + '/comments', tokens.maya, { body: 'Blocked' })).status, 403);
    assert.equal((await run('GET', path + '/comments', tokens.maya)).data.length, 1);
    await run('DELETE', path + '/share', tokens.alex);
    assert.equal((await run('GET', path + '/comments', tokens.maya)).status, 404);
    assert.deepEqual((await run('POST', path + '/presence', tokens.alex)).data.people, []);
    assert.equal((await run('GET', path, tokens.alex)).data.shared, false);
  } finally {
    db.close();
  }
});

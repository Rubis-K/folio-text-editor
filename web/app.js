import { mountPngEditor } from './png-editor.js';
import { mountFile } from './file-preview.js';

const byId = (id) => document.getElementById(id);
const editor = byId('editor');
const title = byId('title');
const toolbar = byId('toolbar');
const format = byId('format');
const textSize = byId('text-size');
const shareDialog = byId('share-dialog');
const organizeDialog = byId('organize-dialog');
const commands = [...toolbar.querySelectorAll('[data-command]')];
const localKey = 'folio.workspace.v1';
const guestKey = 'folio.guest.v1';
const activeKey = 'folio.profile.v1';
const tokenPattern = /^[a-f0-9-]{36}$/;
const state = {
  tokens: {}, token: '', user: null, documents: [], doc: null,
  dirty: false, saving: null, timer: null, selection: null, busy: false, sharing: null, link: null, cleanupFile: null, png: null, collapsedFolders: new Set(),
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, method = 'GET', body) {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const uploading = body instanceof Blob;
  if (body !== undefined && !uploading) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api' + path, {
    method, headers, body: uploading || body === undefined ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error || 'Something went wrong.');
  return data;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function setStatus(text, error = false) {
  byId('status').textContent = text;
  byId('status').classList.toggle('error', error);
}

function notice(error, conflict = false) {
  byId('notice-text').textContent = error?.message || error || '';
  byId('notice').hidden = !error;
  byId('reload').hidden = !conflict;
}

function setEmpty(heading, description, showRetry = false) {
  byId('empty').hidden = false;
  byId('empty-title').textContent = heading;
  byId('empty-description').textContent = description;
  byId('retry').hidden = !showRetry;
}

function deadlineLabel(expiresAt) {
  const days = Math.ceil((expiresAt - Date.now()) / 86_400_000);
  return days <= 0 ? 'Deletion due' : days + (days === 1 ? ' day left' : ' days left');
}

function documentRow(doc, nested = false) {
  const row = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = nested ? 'doc-button nested' : 'doc-button';
  button.title = doc.title;
  if (state.doc?.id === doc.id) button.setAttribute('aria-current', 'page');
  const label = document.createElement('span');
  label.textContent = doc.title;
  button.append(icon(doc.access === 'owner' ? 'file' : 'people'), label);
  if (doc.shared && doc.access === 'owner' && !doc.trashed) {
    const marker = icon('people');
    marker.classList.add('shared-mark');
    button.append(marker);
    button.title = doc.title + ' · Shared';
  }
  if (doc.trashed) {
    label.className = 'trash-name';
    const expiry = document.createElement('span');
    expiry.className = 'trash-days';
    expiry.dataset.expiresAt = doc.expiresAt;
    expiry.textContent = deadlineLabel(doc.expiresAt);
    button.append(expiry);
  }
  button.addEventListener('click', () => runAction(async () => {
    if (doc.id !== state.doc?.id) await openDocument(doc.id);
    closeSidebar();
  }));
  row.append(button);
  return row;
}

function foldersOf(items) {
  return [...new Set(items.map((item) => item.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function renderList() {
  const owned = state.documents.filter((doc) => doc.access === 'owner' && !doc.trashed);
  const shared = state.documents.filter((doc) => doc.access !== 'owner');
  const trash = state.documents.filter((doc) => doc.trashed);
  for (const [key, items, emptyText] of [
    ['owned', owned, 'Your new items will appear here.'],
    ['shared', shared, 'Shared items will appear here.'],
    ['trash', trash, 'Trash is empty.'],
  ]) {
    const list = byId(key);
    byId(key + '-count').textContent = items.length;
    list.replaceChildren(...items.filter((doc) => key !== 'owned' || !doc.folder).map((doc) => documentRow(doc)));
    if (key === 'owned') {
      for (const folder of foldersOf(items)) {
        const row = document.createElement('li');
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'folder-row';
        const arrow = icon('chevron');
        arrow.classList.add('folder-arrow');
        label.append(arrow, icon('folder'), document.createTextNode(folder));
        const children = document.createElement('ul');
        children.setAttribute('aria-label', folder);
        children.hidden = state.collapsedFolders.has(folder);
        label.setAttribute('aria-expanded', String(!children.hidden));
        label.addEventListener('click', () => {
          children.hidden = !children.hidden;
          label.setAttribute('aria-expanded', String(!children.hidden));
          if (children.hidden) state.collapsedFolders.add(folder);
          else state.collapsedFolders.delete(folder);
        });
        children.append(...items.filter((doc) => doc.folder === folder).map((doc) => documentRow(doc, true)));
        row.append(label, children);
        list.append(row);
      }
    }
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'nav-empty';
      li.textContent = emptyText;
      list.append(li);
    }
  }
  if (state.doc?.trashed) byId('trash-nav').open = true;
}

const canManage = (doc) => doc?.access === 'owner' && !doc.trashed;
const canEdit = (doc) => canManage(doc) || doc?.access === 'editor';
const isPng = (doc) => doc?.file?.type === 'image/png';

async function fetchFile(id, token, signal) {
  const response = await fetch('/api/documents/' + id + '/file', {
    headers: { Authorization: 'Bearer ' + token }, signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'The file could not be downloaded.');
  }
  return response.blob();
}

function renderProfile() {
  const user = state.user;
  byId('avatar').textContent = user.initials;
  byId('avatar').classList.toggle('maya', user.id === 'maya');
  byId('profile-name').textContent = user.name;
  byId('profile-label').textContent = 'Demo account';
  byId('switch').hidden = !(state.tokens.alex && state.tokens.maya);
  byId('switch').title = 'Switch to ' + (user.id === 'alex' ? 'Maya' : 'Alex');
  byId('switch').setAttribute('aria-label', byId('switch').title);
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function renderHeading() {
  const doc = state.doc;
  byId('crumb').textContent = doc?.title || 'Documents';
  document.title = doc ? doc.title + ' · Folio' : 'Folio · Workspace';
  if (!doc) return;
  const isOwner = doc.access === 'owner';
  byId('doc-meta').textContent = isOwner
    ? [doc.trashed ? deadlineLabel(doc.expiresAt) : doc.folder, 'Edited ' + dateFormat.format(doc.updatedAt)].filter(Boolean).join(' · ')
    : 'Shared by ' + doc.owner.name;
  const badge = byId('sharing-badge');
  badge.hidden = !doc.shared || doc.trashed;
  badge.textContent = isOwner ? 'Shared' : doc.access === 'editor' ? 'Shared with you · Can edit' : 'Shared with you · View only';
  if (!badge.hidden) badge.prepend(icon('people'));
  byId('share').lastChild.textContent = isOwner && doc.shared ? ' Shared' : ' Share';
  byId('owner-label').textContent = isOwner ? 'Owned by you' : 'Owned by ' + doc.owner.name;
}

function renderMetric() {
  const text = editor.innerText.trim();
  const words = text ? text.split(/\s+/u).length : 0;
  byId('word-count').textContent = words + (words === 1 ? ' word' : ' words');
  editor.classList.toggle('is-empty', !text);
}

function showDocument(doc) {
  clearTimeout(state.timer);
  state.cleanupFile?.();
  state.cleanupFile = null;
  state.png = null;
  state.doc = doc;
  byId('presence').hidden = true;
  byId('export-menu').open = false;
  state.selection = null;
  textSize.value = '3';
  format.value = 'p';
  state.dirty = false;
  byId('workspace').hidden = !doc;
  byId('header-actions').hidden = !doc;
  byId('empty').hidden = Boolean(doc);
  renderHeading();
  renderList();
  if (!doc) {
    setEmpty('No document open', 'Create a document, upload a file, or choose an item from the sidebar.');
    return;
  }
  const editable = canEdit(doc);
  const editingText = editable && !doc.file;
  title.value = doc.title;
  title.readOnly = !editable;
  editor.contentEditable = String(editingText);
  editor.hidden = Boolean(doc.file);
  editor.innerHTML = doc.file ? '' : doc.content;
  toolbar.hidden = !editingText;
  const png = isPng(doc);
  byId('workspace').classList.toggle('png-mode', png);
  byId('viewer-bar').hidden = editable || png;
  byId('save').hidden = !editable;
  byId('share').hidden = !canManage(doc);
  byId('export-menu').hidden = Boolean(doc.file || doc.trashed);
  byId('comments').hidden = Boolean(doc.trashed);
  byId('versions').hidden = Boolean(doc.file || !editable);
  byId('document-tools').hidden = doc.trashed;
  byId('organize').hidden = !canManage(doc);
  byId('delete').hidden = !canManage(doc);
  byId('purge').hidden = !doc.trashed;
  byId('restore').hidden = !doc.trashed;
  byId('word-count').hidden = Boolean(doc.file);
  byId('file-card').hidden = !doc.file;
  if (doc.file) {
    const token = state.token;
    const fileCard = byId('file-card');
    const fetchCurrent = (signal) => fetchFile(doc.id, token, signal);
    if (png) {
      fileCard.replaceChildren();
      if (!doc.trashed) {
        state.png = mountPngEditor(fileCard, fetchCurrent, markDirty, editable);
        state.cleanupFile = state.png.cleanup;
      }
    } else {
      state.cleanupFile = mountFile(fileCard, doc.file, doc.trashed ? null : fetchCurrent);
    }
  }
  setStatus(doc.trashed ? 'In Trash' : editable ? 'Saved' : 'View only');
  renderMetric();
  updateToolbar();
  if (!doc.trashed) void updatePresence();
}

function documentUrl(id) {
  const url = new URL(location.pathname, location.origin);
  if (id) url.searchParams.set('doc', id);
  return url;
}

async function openDocument(id) {
  const doc = id ? await api('/documents/' + id) : null;
  showDocument(doc);
  history.replaceState(null, '', documentUrl(id));
}

async function loadDocuments(preferred) {
  const result = await api('/documents');
  state.user = result.user;
  state.documents = result.documents;
  renderProfile();
  const selected = preferred || state.documents.find((doc) => !doc.trashed)?.id;
  try {
    await openDocument(selected);
  } catch (error) {
    if (error.status !== 404 || !preferred) throw error;
    await openDocument(undefined);
    notice(error);
  }
}

function saveWorkspace(tokens) {
  localStorage.setItem(localKey, JSON.stringify(tokens));
  localStorage.setItem(activeKey, 'alex');
}

async function start() {
  byId('retry').hidden = true;
  notice(null);
  const requested = new URL(location.href).searchParams.get('doc');
  const incoming = new URLSearchParams(location.hash.slice(1)).get('guest');
  const owned = JSON.parse(localStorage.getItem(localKey) || '{}');
  if (incoming && tokenPattern.test(incoming)) {
    if (incoming === owned.maya) {
      localStorage.setItem(activeKey, 'maya');
      sessionStorage.removeItem(guestKey);
    } else {
      sessionStorage.setItem(guestKey, incoming);
    }
    history.replaceState(null, '', documentUrl(requested));
  }
  const guest = sessionStorage.getItem(guestKey);
  if (guest) {
    state.tokens = { maya: guest };
    state.token = guest;
  } else if (owned.alex && owned.maya) {
    state.tokens = owned;
    state.token = state.tokens[localStorage.getItem(activeKey)] || state.tokens.alex;
  } else {
    const created = await api('/workspaces', 'POST');
    state.tokens = created.tokens;
    state.token = created.tokens.alex;
    saveWorkspace(created.tokens);
    await loadDocuments(requested || created.initialDocument);
    return ready();
  }
  try {
    await loadDocuments(requested);
  } catch (error) {
    if (error.status !== 401) throw error;
    if (guest) sessionStorage.removeItem(guestKey);
    else localStorage.removeItem(localKey);
    state.token = '';
    await start();
    return;
  }
  ready();
}

function ready() {
  byId('create').disabled = false;
  byId('import').disabled = false;
}

function initialize() {
  start().catch((error) => {
    setEmpty('Could not open the workspace', error.message, true);
  });
}

function markDirty() {
  if (!canEdit(state.doc)) return;
  state.dirty = true;
  setStatus('Unsaved changes');
  clearTimeout(state.timer);
  state.timer = setTimeout(() => flushSave(), 700);
}

const allowedElements = new Set(['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote']);
function editorMarkup() {
  const output = document.createElement('div');
  function append(source, target) {
    for (const node of source.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        target.append(document.createTextNode(node.data));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.localName;
        const size = tag === 'font' ? node.getAttribute('size') : null;
        if (allowedElements.has(tag) || /^[1-7]$/.test(size || '')) {
          const item = document.createElement(tag);
          if (size) item.setAttribute('size', size);
          target.append(item);
          append(node, item);
        } else {
          append(node, target);
        }
      }
    }
  }
  append(editor, output);
  return output.innerHTML;
}

async function flushSave() {
  clearTimeout(state.timer);
  if (state.saving && !await state.saving) return false;
  while (state.dirty) {
    clearTimeout(state.timer);
    const previous = state.doc;
    const snapshot = {
      title: normalizedTitle(),
      content: previous.file ? undefined : editorMarkup(),
      revision: previous.revision,
    };
    state.dirty = false;
    setStatus('Saving…');
    const save = state.png
      ? state.png.blob().then((blob) => api('/documents/' + previous.id + '/image?revision=' + previous.revision, 'PUT', blob))
      : api('/documents/' + previous.id, 'PUT', snapshot);
    state.saving = save.then((saved) => {
      state.doc = saved;
      state.documents = state.documents.map((doc) => doc.id === saved.id ? saved : doc)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      renderHeading();
      renderList();
      if (!state.dirty) setStatus('Saved');
      return true;
    }).catch((error) => {
      state.dirty = true;
      setStatus(error.status === 409 ? 'Save conflict' : 'Save failed', true);
      notice(error, error.status === 409);
      return false;
    }).finally(() => {
      state.saving = null;
    });
    if (!await state.saving) return false;
  }
  return true;
}

async function runAction(action, saveFirst = true) {
  if (state.busy) return;
  state.busy = true;
  notice(null);
  try {
    if (saveFirst && !await flushSave()) return;
    editor.contentEditable = 'false';
    title.readOnly = true;
    state.png?.enable(false);
    await action();
  } catch (error) {
    notice(error);
  } finally {
    const editable = canEdit(state.doc);
    editor.contentEditable = String(editable && !state.doc.file);
    title.readOnly = !editable;
    state.png?.enable(editable);
    state.busy = false;
  }
}

function closeSidebar() {
  byId('sidebar').classList.remove('open');
  byId('menu').setAttribute('aria-expanded', 'false');
}

function showNewDocument(doc, focusTitle = false) {
  state.documents.unshift(doc);
  showDocument(doc);
  history.replaceState(null, '', documentUrl(doc.id));
  closeSidebar();
  if (focusTitle) {
    title.focus();
    title.select();
  }
}

function updateToolbar() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
  state.selection = selection.getRangeAt(0).cloneRange();
  for (const button of commands) {
    button.setAttribute('aria-pressed', String(document.queryCommandState(button.dataset.command)));
  }
  const block = document.queryCommandValue('formatBlock').toLowerCase();
  format.value = ['h1', 'h2', 'h3'].includes(block) ? block : 'p';
  const size = document.queryCommandValue('fontSize');
  textSize.value = /^[1-7]$/.test(size) ? size : '3';
}

function applyFormat(command, value) {
  if (!canEdit(state.doc)) return;
  if (state.selection && editor.contains(state.selection.commonAncestorContainer)) {
    editor.focus();
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(state.selection);
  } else {
    editor.focus();
  }
  document.execCommand('styleWithCSS', false, false);
  document.execCommand(command, false, value);
  renderMetric();
  updateToolbar();
  markDirty();
}

function itemPath(action = '') {
  return '/documents/' + state.doc.id + (action ? '/' + action : '');
}

function renderSharing() {
  const { recipient, granted, role } = state.sharing;
  byId('recipient-avatar').textContent = recipient.initials;
  byId('recipient-avatar').classList.toggle('maya', recipient.id === 'maya');
  byId('recipient-name').textContent = recipient.name;
  byId('recipient-status').textContent = role === 'editor' ? 'Can edit' : granted ? 'View only' : 'No access';
  byId('access-role').value = role || 'viewer';
  byId('grant').textContent = granted ? 'Update access' : 'Grant access';
  byId('revoke').hidden = !granted;
  const token = state.link.token;
  byId('link-status').textContent = token ? 'Can view this item' : 'Link disabled';
  byId('toggle-link').textContent = token ? 'Disable link' : 'Create link';
  byId('copy').textContent = 'Copy link';
  byId('copy').hidden = !token;
  const url = new URL('/shared', location.origin);
  if (token) url.hash = 'link=' + token;
  byId('share-link').value = token ? url.href : '';
  byId('share-link').hidden = true;
}

async function changeSharing(change) {
  const controls = ['grant', 'revoke', 'access-role', 'toggle-link', 'copy', 'done', 'close-share'].map(byId);
  controls.forEach((button) => { button.disabled = true; });
  shareError(null);
  try {
    await change();
    renderSharing();
    const shared = Boolean(state.sharing.granted || state.link.token);
    updateSharingBadge(shared);
  } catch (error) {
    shareError(error);
  } finally {
    controls.forEach((button) => { button.disabled = false; });
  }
}

function replaceCurrent(item) {
  state.documents = state.documents.map((doc) => doc.id === item.id ? item : doc);
  showDocument(item);
}

function normalizedTitle() {
  return title.value.trim() || (state.doc?.file ? 'Untitled file' : 'Untitled document');
}

function shareError(error) {
  byId('share-error').textContent = error?.message || '';
  byId('share-error').hidden = !error;
}

byId('create').addEventListener('click', () => runAction(async () => {
  const doc = await api('/documents', 'POST', {});
  showNewDocument(doc, true);
}));
byId('import').addEventListener('click', () => byId('file').click());
byId('file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  runAction(async () => {
    if (!/\.txt$/i.test(file.name)) {
      if (!/\.(pdf|docx|png|jpe?g)$/i.test(file.name)) throw new Error('Choose a TXT, PDF, DOCX, PNG, or JPEG file.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Files must be 10 MB or smaller.');
      setStatus('Uploading…');
      try {
        if (/\.pdf$/i.test(file.name)) {
          const { reconstructPdf } = await import('./pdf-import.js');
          const result = await reconstructPdf(file, (page, total) => setStatus('Reading PDF ' + page + '/' + total + '…'));
          const title = file.name.slice(0, -4).trim().slice(0, 100) || 'Imported PDF';
          showNewDocument(await api('/import-pdf', 'POST', { title, content: result.content }));
          if (result.emptyPages) notice(result.emptyPages + ' PDF page(s) contained no selectable text and were skipped.');
        } else {
          showNewDocument(await api('/uploads?name=' + encodeURIComponent(file.name), 'POST', file));
        }
      } finally {
        if (/^(Uploading|Reading PDF)/.test(byId('status').textContent)) setStatus(canEdit(state.doc) ? 'Saved' : 'View only');
      }
      return;
    }
    if (file.size > 128 * 1024) throw new Error('Text files must be 128 KB or smaller.');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new Error('Choose a UTF-8 text file.');
    }
    const doc = await api('/import', 'POST', { name: file.name, text });
    showNewDocument(doc);
  });
});
byId('switch').addEventListener('click', () => runAction(async () => {
  const previous = state.user.id;
  const next = previous === 'alex' ? 'maya' : 'alex';
  state.token = state.tokens[next];
  try {
    await loadDocuments();
    localStorage.setItem(activeKey, next);
    closeSidebar();
  } catch (error) {
    state.token = state.tokens[previous];
    await loadDocuments(state.doc?.id);
    throw error;
  }
}));
byId('menu').addEventListener('click', () => {
  const isOpen = byId('sidebar').classList.toggle('open');
  byId('menu').setAttribute('aria-expanded', String(isOpen));
});
byId('dismiss').addEventListener('click', () => notice(null));
byId('retry').addEventListener('click', initialize);
byId('reload').addEventListener('click', () => {
  if (window.confirm('Discard your unsaved changes and reload the document?')) {
    runAction(() => openDocument(state.doc.id), false);
  }
});
title.addEventListener('input', markDirty);
title.addEventListener('blur', () => { title.value = normalizedTitle(); });
title.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (state.doc?.file) title.blur();
    else editor.focus();
  }
});
editor.addEventListener('input', () => {
  renderMetric();
  markDirty();
});
editor.addEventListener('paste', (event) => {
  if (editor.contentEditable !== 'true') return;
  event.preventDefault();
  document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') || '');
});
editor.addEventListener('drop', (event) => event.preventDefault());
document.addEventListener('selectionchange', updateToolbar);
for (const button of commands) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => applyFormat(button.dataset.command));
}
format.addEventListener('change', () => applyFormat('formatBlock', format.value));
textSize.addEventListener('change', () => applyFormat('fontSize', textSize.value));
function manualSave() {
  notice(null);
  void flushSave();
}
byId('save').addEventListener('click', manualSave);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && canEdit(state.doc)) {
    event.preventDefault();
    manualSave();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (state.dirty || state.saving) event.preventDefault();
});
byId('share').addEventListener('click', () => runAction(async () => {
  [state.sharing, state.link] = await Promise.all([api(itemPath('share')), api(itemPath('link'))]);
  byId('share-heading').textContent = state.doc.file ? 'Share file' : 'Share document';
  byId('share-title').textContent = state.doc.title;
  shareError(null);
  renderSharing();
  shareDialog.showModal();
}));
byId('grant').addEventListener('click', () => changeSharing(async () => {
  state.sharing = await api(itemPath('share'), 'PUT', {
    recipient: state.sharing.recipient.id, role: byId('access-role').value,
  });
}));
byId('revoke').addEventListener('click', () => changeSharing(async () => {
  state.sharing = await api(itemPath('share'), 'DELETE');
}));
byId('toggle-link').addEventListener('click', () => changeSharing(async () => {
  state.link = await api(itemPath('link'), state.link.token ? 'DELETE' : 'PUT');
}));
shareDialog.addEventListener('cancel', (event) => {
  if (byId('grant').disabled) event.preventDefault();
});
for (const id of ['done', 'close-share']) byId(id).addEventListener('click', () => shareDialog.close());
byId('copy').addEventListener('click', async () => {
  const input = byId('share-link');
  input.hidden = false;
  try {
    await navigator.clipboard.writeText(input.value);
    byId('copy').textContent = 'Copied';
  } catch {
    input.focus();
    input.select();
  }
});

byId('organize').addEventListener('click', () => runAction(async () => {
  const select = byId('destination');
  const folders = foldersOf(state.documents.filter((doc) => doc.access === 'owner' && !doc.trashed));
  select.replaceChildren(new Option('No folder', ''), ...folders.map((folder) => new Option(folder, folder)));
  select.value = state.doc.folder;
  byId('new-folder').value = '';
  byId('organize-title').textContent = state.doc.title;
  organizeDialog.showModal();
}));
byId('move-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const folder = byId('new-folder').value.trim() || byId('destination').value;
  organizeDialog.close();
  state.collapsedFolders.delete(folder);
  runAction(async () => replaceCurrent(await api(itemPath('move'), 'PUT', { folder })));
});
const confirmDialog = byId('confirm-dialog');
let confirmedAction;
function confirmItem(heading, message, action) {
  confirmedAction = action;
  confirmDialog.returnValue = 'cancel';
  byId('confirm-heading').textContent = heading + '?';
  byId('confirm-message').textContent = message;
  byId('confirm-action').textContent = heading;
  confirmDialog.showModal();
}
confirmDialog.addEventListener('close', () => {
  const action = confirmedAction;
  confirmedAction = null;
  if (confirmDialog.returnValue === 'confirm' && action) runAction(action);
});
byId('delete').addEventListener('click', () => {
  confirmItem('Move to Trash', '“' + state.doc.title + '” will be permanently deleted after 30 days.',
    async () => replaceCurrent(await api(itemPath(), 'DELETE')));
});
byId('restore').addEventListener('click', () => runAction(async () => {
  replaceCurrent(await api(itemPath('restore'), 'PUT'));
}));
byId('purge').addEventListener('click', () => {
  confirmItem('Delete permanently', '“' + state.doc.title + '” cannot be recovered after deletion.', async () => {
    await api(itemPath('purge'), 'DELETE');
    state.documents = state.documents.filter((doc) => doc.id !== state.doc.id);
    await openDocument(state.documents.find((doc) => !doc.trashed)?.id);
  });
});
setInterval(() => {
  for (const label of document.querySelectorAll('[data-expires-at]')) {
    label.textContent = deadlineLabel(Number(label.dataset.expiresAt));
  }
  if (state.doc?.trashed) renderHeading();
}, 60_000);

function updateSharingBadge(shared) {
  if (state.doc.shared === shared) return;
  state.doc.shared = shared;
  state.documents = state.documents.map((item) => item.id === state.doc.id ? { ...item, shared } : item);
  renderHeading();
  renderList();
}

let activeHeartbeat;
async function updatePresence() {
  const doc = state.doc;
  if (!doc || doc.trashed || document.visibilityState === 'hidden' || activeHeartbeat === doc) return;
  activeHeartbeat = doc;
  const token = state.token;
  try {
    const { people, shared } = await api('/documents/' + doc.id + '/presence', 'POST');
    if (state.doc?.id !== doc.id || state.token !== token || state.doc.trashed) return;
    updateSharingBadge(shared);
    const target = byId('presence');
    const names = people.map((person) => person.name).join(', ');
    if (target.getAttribute('aria-label') !== names) {
      target.setAttribute('aria-label', names);
      target.replaceChildren(...people.map((person) => {
        const avatar = document.createElement('span');
        avatar.className = 'avatar ' + person.id;
        avatar.textContent = person.initials;
        avatar.title = person.name + ' is here';
        return avatar;
      }));
      if (people.length) {
        const label = document.createElement('span');
        label.textContent = names + (people.length === 1 ? ' is here' : ' are here');
        target.append(label);
      }
    }
    target.hidden = people.length === 0;
  } catch {
    if (state.doc?.id === doc.id && state.token === token) byId('presence').hidden = true;
  } finally {
    if (activeHeartbeat === doc) activeHeartbeat = null;
  }
}
setInterval(updatePresence, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void updatePresence(); });

const commentsDialog = byId('comments-dialog');
let commentGeneration = 0;
async function refreshComments(generation, docId) {
  const items = await api('/documents/' + docId + '/comments');
  if (generation !== commentGeneration || !commentsDialog.open) return;
  const list = byId('comment-list');
  if (list.dataset.latest !== items.at(-1)?.id || list.childElementCount !== items.length) {
    list.replaceChildren(...items.map((comment) => {
      const row = document.createElement('li');
      const author = document.createElement('strong');
      author.textContent = comment.author.name;
      const date = document.createElement('time');
      date.textContent = new Date(comment.createdAt).toLocaleString();
      const body = document.createElement('p');
      body.textContent = comment.body;
      row.append(author, date, body);
      return row;
    }));
    list.dataset.latest = items.at(-1)?.id || '';
  }
  byId('comments-status').textContent = items.length ? '' : 'No comments yet.';
}
byId('comments').addEventListener('click', () => {
  const generation = ++commentGeneration;
  const docId = state.doc.id;
  byId('comment-form').hidden = !canEdit(state.doc);
  byId('comment-body').value = '';
  byId('comment-list').replaceChildren();
  byId('comments-status').textContent = 'Loading comments…';
  commentsDialog.showModal();
  const refresh = () => refreshComments(generation, docId).catch((error) => {
    if (generation === commentGeneration) byId('comments-status').textContent = error.message;
  });
  void refresh();
  const timer = setInterval(refresh, 5000);
  commentsDialog.addEventListener('close', () => { clearInterval(timer); commentGeneration++; }, { once: true });
});
byId('comment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const generation = commentGeneration;
  const docId = state.doc.id;
  const input = byId('comment-body');
  const button = byId('post-comment');
  const text = input.value.trim();
  if (!text || button.disabled) return;
  button.disabled = true;
  try {
    await api('/documents/' + docId + '/comments', 'POST', { body: text });
    if (generation === commentGeneration && input.value.trim() === text) input.value = '';
    await refreshComments(generation, docId);
  } catch (error) {
    if (generation === commentGeneration) byId('comments-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const versionsDialog = byId('versions-dialog');
const versionSelect = byId('version-select');
let currentVersion;
let versionRequest = 0;
async function previewVersion() {
  const request = ++versionRequest;
  byId('restore-version').hidden = true;
  byId('version-title').textContent = '';
  byId('version-preview').replaceChildren();
  byId('versions-status').textContent = 'Loading version…';
  try {
    const item = await api(itemPath('versions') + '?revision=' + versionSelect.value);
    if (request !== versionRequest || !versionsDialog.open) return;
    byId('versions-status').textContent = '';
    byId('version-title').textContent = item.title;
    byId('version-preview').innerHTML = item.content;
    byId('restore-version').hidden = !canManage(state.doc) || Number(versionSelect.value) === currentVersion;
  } catch (error) {
    if (request === versionRequest) byId('versions-status').textContent = error.message;
  }
}
versionSelect.addEventListener('change', previewVersion);
byId('versions').addEventListener('click', () => runAction(async () => {
  const versions = await api(itemPath('versions'));
  currentVersion = versions[0].revision;
  versionSelect.replaceChildren(...versions.map((version, index) => {
    const label = new Date(version.createdAt).toLocaleString() + ' · ' + version.author.name;
    return new Option(index === 0 ? 'Current · ' + label : label, version.revision);
  }));
  versionsDialog.showModal();
  void previewVersion();
}));
byId('restore-version').addEventListener('click', () => {
  const revision = Number(versionSelect.value);
  versionsDialog.close();
  confirmItem('Restore this version', 'This creates a new saved version. Earlier versions remain in history.',
    async () => replaceCurrent(await api(itemPath('versions'), 'PUT', { revision, currentRevision: currentVersion })));
});

const exportMenu = byId('export-menu');
for (const button of exportMenu.querySelectorAll('[data-export]')) {
  button.addEventListener('click', () => {
    if (state.doc?.file || !state.doc) return;
    const snapshot = document.createElement('div');
    snapshot.innerHTML = editorMarkup();
    const name = normalizedTitle();
    const type = button.dataset.export;
    exportMenu.open = false;
    import('./export.js').then(({ exportDocument }) => exportDocument(type, name, snapshot)).catch((error) => notice(error));
  });
}
document.addEventListener('click', (event) => {
  if (exportMenu.open && !exportMenu.contains(event.target)) exportMenu.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && exportMenu.open) {
    exportMenu.open = false;
    exportMenu.querySelector('summary').focus();
  }
});

initialize();

import { mountPngEditor } from './png-editor.js';
import { mountFile } from './file-preview.js';

const token = new URLSearchParams(location.hash.slice(1)).get('link');
const byId = (id) => document.getElementById(id);
const message = byId('shared-message');

async function sharedRequest(path, signal) {
  const response = await fetch('/api/shared' + path, {
    headers: { Authorization: 'Bearer ' + token }, signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'This shared item could not be loaded.');
  }
  return response;
}

async function showShared() {
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    throw new Error('Open the complete link you received from the owner.');
  }
  const item = await (await sharedRequest('')).json();
  byId('shared-title').textContent = item.title;
  byId('shared-owner').textContent = 'Shared by ' + item.owner.name;
  document.title = item.title + ' · Folio';
  byId('shared-body').hidden = Boolean(item.file);
  byId('shared-file').hidden = !item.file;
  if (item.file) {
    const fetchFile = async (signal) => (await sharedRequest('/file', signal)).blob();
    if (item.file.type === 'image/png') {
      byId('shared-file').classList.add('png-card');
      document.querySelector('.shared-heading').hidden = true;
      document.querySelector('.viewer-bar').hidden = true;
      mountPngEditor(byId('shared-file'), fetchFile, () => {}, false);
    } else {
      mountFile(byId('shared-file'), item.file, fetchFile);
    }
  } else {
    byId('shared-body').innerHTML = item.content;
  }
  message.hidden = true;
  byId('shared-document').hidden = false;
}

showShared().catch((error) => { message.textContent = error.message; });
window.addEventListener('hashchange', () => location.reload());

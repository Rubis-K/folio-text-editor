const labels = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG' };

export function mountFile(container, file, fetchFile) {
  const controller = new AbortController();
  let objectUrl;
  container.replaceChildren();
  const name = document.createElement('h2');
  name.textContent = file.name;
  const meta = document.createElement('p');
  const size = file.size >= 1024 * 1024
    ? (file.size / (1024 * 1024)).toFixed(1) + ' MB'
    : Math.max(1, Math.ceil(file.size / 1024)) + ' KB';
  meta.textContent = (labels[file.type] || 'DOCX') + ' · ' + size;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'file-actions';
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'secondary';
  download.textContent = 'Download file';
  actions.append(download);
  container.append(name, meta, actions, status);
  if (!fetchFile) {
    download.hidden = true;
    status.textContent = 'Restore this item to download the file.';
  }

  async function loadFile() {
    if (!objectUrl) {
      const blob = await fetchFile(controller.signal);
      if (controller.signal.aborted) return '';
      objectUrl = URL.createObjectURL(blob);
    }
    return objectUrl;
  }

  async function load(showImage) {
    download.disabled = true;
    status.textContent = showImage ? 'Loading image…' : 'Preparing download…';
    try {
      const url = await loadFile();
      if (!url) return;
      if (showImage) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = file.name;
        container.append(image);
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.click();
      }
      status.textContent = '';
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message;
    } finally {
      download.disabled = false;
    }
  }

  if (fetchFile) {
    download.addEventListener('click', () => load(false));
    if (file.type.startsWith('image/')) void load(true);
  }
  return () => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

const tools = [
  ['brush', 'Brush'], ['erase', 'Eraser'], ['rectangle', 'Rectangle'], ['text', 'Text'], ['crop', 'Crop'],
];

export function mountPngEditor(container, fetchFile, onEdit, editable = true) {
  const controller = new AbortController();
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'PNG image');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const toolbar = document.createElement('div');
  toolbar.className = 'png-toolbar';
  toolbar.setAttribute('aria-label', 'Image editing tools');
  const mode = document.createElement('select');
  mode.setAttribute('aria-label', 'Image tool');
  mode.replaceChildren(...tools.map(([value, label]) => new Option(label, value)));
  const color = document.createElement('input');
  color.type = 'color';
  color.value = '#196e5a';
  color.setAttribute('aria-label', 'Image color');
  const width = document.createElement('select');
  width.setAttribute('aria-label', 'Image tool size');
  width.replaceChildren(...[2, 5, 10, 20, 36, 64].map((size) => new Option(size + ' px', size)));
  width.value = '10';
  const text = document.createElement('input');
  text.placeholder = 'Text to place';
  text.setAttribute('aria-label', 'Text to place');
  text.maxLength = 160;
  text.hidden = true;
  mode.addEventListener('change', () => { text.hidden = mode.value !== 'text'; });
  toolbar.append(mode, color, width, text);
  const status = document.createElement('p');
  status.className = 'png-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Loading image…';
  const stage = document.createElement('div');
  stage.className = 'png-stage';
  stage.append(canvas);
  stage.hidden = true;
  container.replaceChildren(toolbar, status, stage);

  let ready = false;
  let enabled = editable;
  let gesture;
  const undo = [];
  const redo = [];
  const pixels = () => context.getImageData(0, 0, canvas.width, canvas.height);
  function output(image) {
    canvas.width = image.width;
    canvas.height = image.height;
    context.putImageData(image, 0, 0);
  }
  function push(stack, image) {
    stack.push(image);
    const limit = Math.max(1, Math.min(12, Math.floor(48 * 1024 * 1024 / image.data.byteLength)));
    if (stack.length > limit) stack.shift();
  }
  function refresh() {
    toolbar.hidden = !editable || !ready;
    for (const input of toolbar.querySelectorAll('input, select, button')) input.disabled = !ready || !enabled;
    undoButton.disabled ||= !undo.length;
    redoButton.disabled ||= !redo.length;
    canvas.classList.toggle('drawable', ready && enabled);
  }
  function commit(before) {
    push(undo, before);
    redo.length = 0;
    status.textContent = '';
    refresh();
    onEdit();
  }
  function button(label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'secondary';
    element.textContent = label;
    element.addEventListener('click', action);
    toolbar.append(element);
    return element;
  }
  const undoButton = button('Undo', () => {
    push(redo, pixels());
    output(undo.pop());
    refresh();
    onEdit();
  });
  const redoButton = button('Redo', () => {
    push(undo, pixels());
    output(redo.pop());
    refresh();
    onEdit();
  });
  function transform(rotate) {
    const before = pixels();
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    if (rotate) {
      canvas.width = copy.height;
      canvas.height = copy.width;
      context.translate(canvas.width, 0);
      context.rotate(Math.PI / 2);
    } else {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(copy, 0, 0);
    context.resetTransform();
    commit(before);
  }
  button('Rotate 90°', () => transform(true));
  button('Flip horizontal', () => transform(false));

  function point(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - box.x) * canvas.width / box.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - box.y) * canvas.height / box.height)),
    };
  }
  function stroke(from, to, erase) {
    context.save();
    context.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    context.strokeStyle = color.value;
    context.lineWidth = Number(width.value);
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x + (from.x === to.x && from.y === to.y ? .01 : 0), to.y);
    context.stroke();
    context.restore();
  }
  function bounds(start, end) {
    return [
      Math.floor(Math.min(start.x, end.x)), Math.floor(Math.min(start.y, end.y)),
      Math.round(Math.abs(start.x - end.x)), Math.round(Math.abs(start.y - end.y)),
    ];
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (!enabled || !ready || gesture || event.button !== 0) return;
    const start = point(event);
    const type = mode.value;
    if (type === 'text' && !text.value.trim()) {
      text.focus();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    gesture = { id: event.pointerId, type, start, last: start, before: pixels() };
    if (type === 'brush' || type === 'erase') stroke(start, start, type === 'erase');
    if (type === 'text') {
      context.font = Math.max(12, Number(width.value) * 2) + 'px sans-serif';
      context.textBaseline = 'top';
      context.fillStyle = color.value;
      context.fillText(text.value, start.x, start.y);
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (gesture?.id !== event.pointerId) return;
    const next = point(event);
    if (gesture.type === 'brush' || gesture.type === 'erase') {
      stroke(gesture.last, next, gesture.type === 'erase');
    } else if (gesture.type === 'crop' || gesture.type === 'rectangle') {
      context.putImageData(gesture.before, 0, 0);
      context.save();
      context.strokeStyle = gesture.type === 'crop' ? '#ffffff' : color.value;
      context.lineWidth = gesture.type === 'crop' ? 2 : Number(width.value);
      if (gesture.type === 'crop') {
        context.shadowColor = '#172530';
        context.shadowBlur = 3;
        context.setLineDash([5, 5]);
      }
      context.strokeRect(...bounds(gesture.start, next));
      context.restore();
    }
    gesture.last = next;
  });
  canvas.addEventListener('pointerup', (event) => {
    if (gesture?.id !== event.pointerId) return;
    const current = gesture;
    gesture = null;
    if (current.type === 'crop' || current.type === 'rectangle') {
      context.putImageData(current.before, 0, 0);
      const rectangle = bounds(current.start, point(event));
      if (rectangle[2] < 2 || rectangle[3] < 2) return;
      if (current.type === 'crop') output(context.getImageData(...rectangle));
      else {
        context.strokeStyle = color.value;
        context.lineWidth = Number(width.value);
        context.strokeRect(...rectangle);
      }
    }
    commit(current.before);
  });
  canvas.addEventListener('pointercancel', () => {
    if (gesture) context.putImageData(gesture.before, 0, 0);
    gesture = null;
  });

  refresh();
  fetchFile(controller.signal).then(async (blob) => {
    const image = await createImageBitmap(blob);
    try {
      if (controller.signal.aborted) return;
      if (editable && image.width * image.height > 16_000_000) {
        enabled = false;
        status.textContent = 'This image exceeds the 16-megapixel editing limit.';
        const preview = document.createElement('img');
        const url = URL.createObjectURL(blob);
        preview.alt = 'PNG image';
        preview.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        controller.signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true });
        preview.src = url;
        container.append(preview);
        return;
      }
      canvas.width = image.width;
      canvas.height = image.height;
      context.drawImage(image, 0, 0);
      stage.hidden = false;
      status.textContent = '';
      ready = true;
      refresh();
    } finally {
      image.close();
    }
  }).catch((error) => {
    if (!controller.signal.aborted) status.textContent = error.message || 'Could not display this PNG.';
  });

  return {
    cleanup() { controller.abort(); },
    enable(value) {
      if (!value && gesture) {
        context.putImageData(gesture.before, 0, 0);
        gesture = null;
      }
      enabled = editable && value;
      refresh();
    },
    blob() {
      return new Promise((resolve, reject) => canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not save this PNG.'));
      }, 'image/png'));
    },
  };
}

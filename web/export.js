const htmlEscape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const fontSizes = [null, 7.5, 9.75, 12, 13.5, 18, 24, 36];
const blockTags = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);

function textExport(editor) {
  function walk(node, depth = 0) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeName === 'BR') return '\n';
    if (node.nodeName === 'UL' || node.nodeName === 'OL') {
      return '\n' + Array.from(node.children).map((item, index) => {
        const prefix = node.nodeName === 'OL' ? (index + 1) + '. ' : '• ';
        return '  '.repeat(Math.min(depth, 10)) + prefix + walk(item, depth + 1).trimEnd();
      }).join('\n') + '\n';
    }
    const content = Array.from(node.childNodes).map((child) => walk(child, depth)).join('');
    return blockTags.has(node.nodeName) ? content + '\n' : content;
  }
  return walk(editor).replace(/\n{3,}/g, '\n\n').trimEnd();
}

function pdfBlocks(root, inherited = {}) {
  const output = [];
  let inline = [];
  function flush() {
    if (inline.length) output.push({ text: inline, margin: [0, 0, 0, 6] });
    inline = [];
  }
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      inline.push({ text: node.data, ...inherited });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName;
    if (tag === 'BR') {
      inline.push('\n');
      continue;
    }
    if (tag === 'UL' || tag === 'OL') {
      flush();
      const items = [...node.children].map((item) => ({ stack: pdfBlocks(item, inherited) }));
      if (items.length) output.push({ [tag.toLowerCase()]: items, margin: [0, 0, 0, 4] });
      continue;
    }
    const style = { ...inherited };
    if (tag === 'B' || tag === 'STRONG') style.bold = true;
    if (tag === 'I' || tag === 'EM') style.italics = true;
    if (tag === 'U') style.decoration = 'underline';
    if (tag === 'FONT') style.fontSize = fontSizes[Number(node.getAttribute('size'))] || 12;
    if (/^H[1-3]$/.test(tag)) {
      style.bold = true;
      style.fontSize = { H1: 25, H2: 18, H3: 14 }[tag];
    }
    const child = pdfBlocks(node, style);
    if (blockTags.has(tag) || child.some((block) => !block.text)) {
      flush();
      output.push(...child);
    } else {
      for (const block of child) inline.push(...block.text);
    }
  }
  flush();
  return output;
}

let pdfScripts;
function script(path) {
  return new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = path;
    element.onload = resolve;
    element.onerror = () => { element.remove(); reject(new Error('The PDF exporter could not load. Try again.')); };
    document.head.append(element);
  });
}

async function exportPdf(title, editor) {
  pdfScripts ??= script('/pdfmake.min.js').then(() => script('/pdfmake-fonts.js')).catch((error) => {
    pdfScripts = null;
    throw error;
  });
  await pdfScripts;
  const content = pdfBlocks(editor);
  const document = window.pdfMake.createPdf({
    info: { title }, pageMargins: [54, 50, 54, 50], defaultStyle: { fontSize: 12, lineHeight: 1.16 },
    content: content.length ? content : [{ text: '' }],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The PDF took too long to generate.')), 30_000);
    try {
      const result = document.getBlob((blob) => { clearTimeout(timeout); resolve(blob); });
      result?.catch((error) => { clearTimeout(timeout); reject(error); });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export async function exportDocument(format, title, editor) {
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '') || 'Untitled document';
  let blob;
  if (format === 'pdf') blob = await exportPdf(title, editor);
  if (format === 'txt') blob = new Blob(['\uFEFF', textExport(editor)], { type: 'text/plain;charset=utf-8' });
  if (format === 'doc') {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + htmlEscape(title) + '</title></head><body>'
      + editor.innerHTML + '</body></html>';
    blob = new Blob(['\uFEFF', html], { type: 'application/msword;charset=utf-8' });
  }
  if (!blob) throw new Error('Choose PDF, TXT, or DOC.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name + '.' + format;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

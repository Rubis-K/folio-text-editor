import { getDocument, GlobalWorkerOptions } from '/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

const escaped = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function linesFrom(items) {
  const lines = [];
  let line;
  for (const item of items) {
    if (!('str' in item)) continue;
    const [, , , , x, y] = item.transform;
    const height = Math.abs(item.height) || Math.abs(item.transform[3]) || 12;
    if (!line || Math.abs(line.y - y) > Math.max(3, height * .55)) {
      line = { text: '', y, height, end: x };
      lines.push(line);
    }
    if (line.text && !/\s$/.test(line.text) && x - line.end > Math.max(1.5, height * .17)) line.text += ' ';
    line.text += item.str;
    line.height = Math.max(line.height, height);
    line.end = x + item.width;
    if (item.hasEOL) line = null;
  }
  return lines.filter(({ text }) => text.trim()).map((line) => ({ ...line, text: line.text.trim() }));
}

function blocksFrom(lines) {
  const sizes = lines.map((line) => line.height).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] || 12;
  let paragraph = [];
  let previous;
  const blocks = [];
  function flush() {
    if (paragraph.length) blocks.push('<p>' + paragraph.map(escaped).join('<br>') + '</p>');
    paragraph = [];
  }
  for (const line of lines) {
    if (line.height > bodySize * 1.42 && line.text.length < 120) {
      flush();
      blocks.push('<h2>' + escaped(line.text) + '</h2>');
    } else {
      if (previous && Math.abs(previous.y - line.y) > Math.max(bodySize, previous.height) * 1.65) flush();
      paragraph.push(line.text);
    }
    previous = line;
  }
  flush();
  return blocks.join('');
}

export async function reconstructPdf(file, progress = () => {}) {
  const task = getDocument({ data: await file.arrayBuffer(), useWasm: false, isEvalSupported: false, useSystemFonts: true });
  let document;
  try {
    task.onPassword = () => { void task.destroy(); };
    document = await task.promise;
    if (document.numPages > 100) throw new Error('Choose a PDF with 100 pages or fewer.');
    const content = [];
    let emptyPages = 0;
    let size = 0;
    const encoder = new TextEncoder();
    for (let number = 1; number <= document.numPages; number++) {
      progress(number, document.numPages);
      const page = await document.getPage(number);
      const blocks = blocksFrom(linesFrom((await page.getTextContent()).items));
      page.cleanup();
      if (!blocks) {
        emptyPages++;
        continue;
      }
      size += encoder.encode(blocks).byteLength;
      if (size > 700 * 1024) throw new Error('This PDF contains too much text for a single Folio document.');
      content.push(blocks);
    }
    if (!content.length) throw new Error('This PDF has no selectable text. Upload a text-based PDF.');
    return { content: content.join(''), emptyPages };
  } catch (error) {
    if (!document && error.name !== 'InvalidPDFException') throw new Error('Could not open this PDF. Check that it is readable and does not require a password.');
    throw error;
  } finally {
    await task.destroy();
  }
}

import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp, purgeExpired } from '../src/worker.js';
import { openDatabase } from './database.mjs';
import { openFiles } from './files.mjs';

const directory = new URL('../.data/', import.meta.url);
mkdirSync(directory, { recursive: true });
const db = openDatabase(process.env.FOLIO_DB || new URL('folio.sqlite', directory).pathname);
const files = openFiles(process.env.FOLIO_FILES || fileURLToPath(new URL('files/', directory)));
const assets = Object.fromEntries(['index.html', 'style.css', 'app.js', 'shared.html', 'shared.js', 'file-preview.js', 'export.js', 'png-editor.js', 'pdf-import.js', 'walkthrough.html'].map((name) => [
  name, () => readFileSync(new URL('../web/' + name, import.meta.url), 'utf8'),
]));
assets['walkthrough.vtt'] = () => readFileSync(new URL('../media/walkthrough.vtt', import.meta.url), 'utf8');
assets['walkthrough.mp4'] = () => readFileSync(new URL('../media/walkthrough.mp4', import.meta.url));
for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  assets[name] = () => readFileSync(new URL('../node_modules/pdfjs-dist/build/' + name, import.meta.url), 'utf8');
}
assets['pdfmake.min.js'] = () => readFileSync(new URL('../node_modules/pdfmake/build/pdfmake.min.js', import.meta.url), 'utf8');
assets['pdfmake-fonts.js'] = () => readFileSync(new URL('../node_modules/pdfmake/build/vfs_fonts.js', import.meta.url), 'utf8');
const app = createApp(assets);
setInterval(() => purgeExpired({ DB: db, BUCKET: files }).catch(console.error), 60 * 60 * 1000).unref();
const { values } = parseArgs({
  options: { host: { type: 'string' }, port: { type: 'string' }, strictPort: { type: 'boolean' } },
});
const port = Number(values.port ?? process.env.PORT ?? 3000);
const host = values.host ?? '127.0.0.1';

createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method || 'GET';
    const body = ['GET', 'HEAD'].includes(method) ? undefined : Readable.toWeb(incoming);
    const request = new Request('http://localhost' + incoming.url, {
      method, headers: incoming.headers, body, duplex: 'half',
    });
    const response = await app(request, { DB: db, BUCKET: files });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500).end();
  }
}).listen(port, host, () => console.log('Folio is running on http://' + host + ':' + port));

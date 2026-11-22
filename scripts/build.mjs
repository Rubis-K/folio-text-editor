import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const assets = {};
for (const file of ['index.html', 'style.css', 'app.js', 'shared.html', 'shared.js', 'file-preview.js', 'export.js', 'png-editor.js', 'pdf-import.js', 'walkthrough.html']) {
  assets[file] = await readFile(new URL('web/' + file, root), 'utf8');
}
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  assets[file] = await readFile(new URL('node_modules/pdfjs-dist/build/' + file, root), 'utf8');
}
assets['pdfmake.min.js'] = await readFile(new URL('node_modules/pdfmake/build/pdfmake.min.js', root), 'utf8');
assets['pdfmake-fonts.js'] = await readFile(new URL('node_modules/pdfmake/build/vfs_fonts.js', root), 'utf8');
assets['walkthrough.vtt'] = await readFile(new URL('media/walkthrough.vtt', root), 'utf8');
assets['walkthrough.mp4'] = (await readFile(new URL('media/walkthrough.mp4', root))).toString('base64');
const app = await readFile(new URL('src/worker.js', root), 'utf8');
await mkdir(new URL('dist/server/', root), { recursive: true });
await mkdir(new URL('dist/.openai/', root), { recursive: true });
await writeFile(new URL('dist/server/index.js', root), 'const ASSETS = ' + JSON.stringify(assets) + ';\n' + app);
await copyFile(new URL('.openai/hosting.json', root), new URL('dist/.openai/hosting.json', root));
await import(new URL('dist/server/index.js', root));

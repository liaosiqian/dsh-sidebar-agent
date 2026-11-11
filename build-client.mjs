import { readFile, writeFile } from 'node:fs/promises';
const url = new URL('./client.js', import.meta.url);
const source = await readFile(url, 'utf8');
const settings = await readFile(new URL('./model-settings-client.js', import.meta.url), 'utf8');
const start = '// BEGIN generated sidebar model settings';
const end = '// END generated sidebar model settings';
const before = source.indexOf(start);
const after = source.indexOf(end, before);
if (before < 0 || after < 0) throw new Error('Missing model settings build markers');
const next = source.slice(0, before) + start + '\n' + settings + '\n' + source.slice(after);
if (process.argv.includes('--check')) {
  if (next !== source) throw new Error('Rebuild the client artifact with node build-client.mjs');
} else if (next !== source) await writeFile(url, next);

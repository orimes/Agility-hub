// Static build step for Agility Hub.
//
// Input : bundle.src.html  — the legacy self-extracting bundle (a JSON manifest
//                            of gzip+base64 assets plus a JSON-encoded HTML
//                            template, unpacked by inline JS via DOM-swap).
// Output: index.html        — plain semantic HTML served on the first byte.
//         assets/           — fonts + runtime JS as external, cacheable files.
//
// This replaces the runtime "unpacker" (DecompressionStream + DOMParser +
// document.replaceWith) with an ahead-of-time decode. No framework, no deps —
// just Node built-ins. Re-run with: `node build.mjs`.
//
// It also (1) self-hosts React/ReactDOM under assets/vendor/ so the site no
// longer depends on unpkg.com at runtime, and (2) bakes a pre-rendered HTML
// snapshot of the app into index.html (see prerender.mjs) so real content —
// not an empty shell — is visible on the first byte, even before JS runs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const SRC = 'bundle.src.html';
const OUT_HTML = 'index.html';
const ASSET_DIR = 'assets';
const FONT_DIR = path.join(ASSET_DIR, 'fonts');
const VENDOR_DIR = path.join(ASSET_DIR, 'vendor');

// React UMD pinned to the versions the runtime was built against. The SRI
// hashes are the ones dc-runtime.js already shipped — identical bytes from
// unpkg, so integrity checks still pass against our local copies.
const REACT_PIN = [
  {
    file: 'react.production.min.js',
    url: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
    sri: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
  },
  {
    file: 'react-dom.production.min.js',
    url: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
    sri: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1',
  },
];

const sri384 = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

// Download React locally if it isn't already vendored (network only on first
// build; committed thereafter). Verifies bytes against the pinned SRI.
async function ensureVendor() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  for (const { file, url, sri } of REACT_PIN) {
    const dest = path.join(VENDOR_DIR, file);
    if (fs.existsSync(dest) && sri384(fs.readFileSync(dest)) === sri) continue;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sri384(buf) !== sri) throw new Error(`SRI mismatch for ${file}`);
    fs.writeFileSync(dest, buf);
    console.log(`  fetched ${VENDOR_DIR}/${file}`);
  }
}
await ensureVendor();

const html = fs.readFileSync(SRC, 'utf8');

function extractScript(type) {
  const re = new RegExp('<script type="__bundler/' + type + '">([\\s\\S]*?)<\\/script>', 'i');
  const m = html.match(re);
  if (!m) throw new Error(`missing <script type="__bundler/${type}">`);
  return m[1].trim();
}

const manifest = JSON.parse(extractScript('manifest'));
let template = JSON.parse(extractScript('template'));

// --- decode every asset to real bytes (gunzip if the bundler compressed it) ---
function decode(entry) {
  let bytes = Buffer.from(entry.data, 'base64');
  if (entry.compressed) bytes = zlib.gunzipSync(bytes);
  return bytes;
}

const EXT = { 'font/woff2': '.woff2', 'text/javascript': '.js', 'text/css': '.css' };

// Build a human-readable name for each font from its first @font-face block in
// the template: family + subset comment (e.g. assistant-hebrew.woff2). Falls
// back to the uuid when context can't be found.
function fontName(uuid) {
  const at = template.indexOf(`url("${uuid}")`);
  if (at === -1) return uuid;
  const before = template.slice(Math.max(0, at - 600), at);
  const fam = (before.match(/font-family:\s*'([^']+)'/gi) || []).pop();
  const family = fam ? fam.replace(/font-family:\s*'/i, '').replace("'", '') : 'font';
  const subsetMatch = before.match(/\/\*\s*([a-z0-9 -]+?)\s*\*\//gi);
  const subset = subsetMatch ? subsetMatch.pop().replace(/\/\*\s*|\s*\*\//g, '') : '';
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [slug(family), slug(subset)].filter(Boolean).join('-');
}

// Wipe only the generated fonts (leave assets/vendor/ — the React copies —
// in place). dc-runtime.js is overwritten below.
fs.rmSync(FONT_DIR, { recursive: true, force: true });
fs.mkdirSync(FONT_DIR, { recursive: true });

const usedNames = new Set();
const urlFor = {}; // uuid -> relative path written into the HTML

for (const [uuid, entry] of Object.entries(manifest)) {
  const bytes = decode(entry);
  const ext = EXT[entry.mime] || '.bin';

  let rel;
  if (entry.mime === 'font/woff2') {
    let base = fontName(uuid);
    let name = base + ext;
    let i = 2;
    while (usedNames.has(name)) name = `${base}-${i++}${ext}`;
    usedNames.add(name);
    fs.writeFileSync(path.join(FONT_DIR, name), bytes);
    rel = `${ASSET_DIR}/fonts/${name}`;
  } else if (entry.mime === 'text/javascript') {
    const name = 'dc-runtime.js';
    // Point the runtime at the self-hosted React instead of unpkg.com. The
    // SRI/crossorigin attrs in the runtime still apply and pass (same bytes,
    // same-origin request).
    let js = bytes.toString('utf8');
    for (const { url, file } of REACT_PIN) {
      js = js.split(url).join(`${ASSET_DIR}/vendor/${file}`);
    }
    fs.writeFileSync(path.join(ASSET_DIR, name), js);
    rel = `${ASSET_DIR}/${name}`;
  } else {
    const name = uuid + ext;
    fs.writeFileSync(path.join(ASSET_DIR, name), bytes);
    rel = `${ASSET_DIR}/${name}`;
  }

  urlFor[uuid] = rel;
  // Replace every UUID reference in the template with the real relative path.
  template = template.split(uuid).join(rel);
}

// The template already declares <!DOCTYPE html><html><head>…</head><body>…,
// so it IS the document. Write it verbatim — semantic HTML on the first byte,
// no runtime decode, no DOM swap. The dc-runtime <script> renders <x-dc> as
// progressive enhancement.
if (!/^\s*<!doctype html>/i.test(template)) {
  template = '<!DOCTYPE html>\n' + template;
}

// Give crawlers/assistive tech a real <title> + description on the first byte
// instead of waiting for the runtime <helmet> to set them. The runtime is
// still free to override these once it boots.
if (!/<title>/i.test(template)) {
  const head = `<title>Agility Hub</title>\n<meta name="description" content="Agility Hub — video library, blog, and class schedules.">\n`;
  template = template.replace(/(<meta charset="[^"]*">\s*)/i, `$1${head}`);
}

fs.writeFileSync(OUT_HTML, template);

console.log(`✓ wrote ${OUT_HTML} (${(template.length / 1024).toFixed(1)} KB)`);
console.log(`✓ wrote ${Object.keys(manifest).length} assets to ${ASSET_DIR}/`);
for (const [uuid, rel] of Object.entries(urlFor)) {
  const size = fs.statSync(rel).size;
  console.log(`    ${rel}  (${(size / 1024).toFixed(1)} KB)`);
}

// Bake in the pre-rendered snapshot (needs a local Chrome + puppeteer-core).
// Best-effort: if either is missing, the shell above is still a valid build —
// just without the first-byte content snapshot.
try {
  const { prerender } = await import('./prerender.mjs');
  await prerender();
} catch (err) {
  console.warn(`! skipped pre-render (${err.message}). ` +
    `index.html is the shell only; run \`npm i && node prerender.mjs\` with Chrome installed to add the snapshot.`);
}

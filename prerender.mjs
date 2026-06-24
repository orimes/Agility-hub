// Pre-render step for Agility Hub.
//
// Runs the built page in headless Chrome, lets dc-runtime render the React app,
// and bakes the result back into index.html as a static snapshot. The effect:
// real content (header, hero, video library, footer) is visible on the first
// byte — to humans before JS loads, and to crawlers / link-preview bots that
// don't run JS at all. The <x-dc> template is kept intact, so once dc-runtime
// boots it renders the live, interactive app and the snapshot is removed.
//
// Uses the system Chrome via puppeteer-core (no Chromium download). Run after
// build.mjs:  `node prerender.mjs`  (build.mjs also invokes it automatically).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTML = 'index.html';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('Chrome not found. Set CHROME_PATH to the browser executable.');
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml',
};

// Minimal static server so Chrome loads over http:// (same-origin, real fetch,
// SRI all behave as in production — unlike file://).
function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/') rel = '/' + HTML;
      const file = path.join(dir, rel);
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function prerender({ root = ROOT, htmlFile = HTML } = {}) {
  const htmlPath = path.join(root, htmlFile);
  const original = fs.readFileSync(htmlPath, 'utf8');

  const server = await serve(root);
  const port = server.address().port;
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/${htmlFile}`, { waitUntil: 'networkidle0', timeout: 30000 });
    // Wait until the runtime has mounted real content into #dc-root.
    await page.waitForFunction(
      () => { const r = document.getElementById('dc-root'); return r && r.childElementCount > 0; },
      { timeout: 30000 },
    );

    const cap = await page.evaluate(() => {
      const root = document.getElementById('dc-root');
      return {
        headHTML: document.head.innerHTML,
        snapshot: root ? root.innerHTML : null,
        hasFontFace: document.head.innerHTML.includes('@font-face'),
      };
    });

    if (!cap.snapshot) throw new Error('nothing rendered into #dc-root');

    // --- assemble the new <head> ---
    // Drop the dynamically-injected scripts (React/Babel/dc-runtime were added
    // at runtime); keep all styles + meta + the hoisted <helmet> font CSS.
    let head = cap.headHTML.replace(/<script\b[\s\S]*?<\/script>/gi, '').trim();
    // Re-add the single canonical runtime script so the page still boots.
    head += '\n<script src="assets/vendor/react.production.min.js"></script>';
    head += '\n<script src="assets/vendor/react-dom.production.min.js"></script>';
    head += '\n<script src="assets/dc-runtime.js"></script>';
    // Guarantee the raw template stays hidden for no-JS visitors too.
    if (!/x-dc\s*\{[^}]*display\s*:\s*none/i.test(head)) {
      head += '\n<style>x-dc{display:none!important}</style>';
    }

    // --- keep the original <body> (x-dc template + dc-script), strip any
    // previous snapshot, then inject the fresh snapshot + a tiny coordinator. ---
    const bodyMatch = original.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (!bodyMatch) throw new Error('no <body> in source');
    let bodyInner = bodyMatch[1]
      .replace(/<div id="dc-prerender"[\s\S]*?<\/div>\s*(?=<script|<\/body|$)/i, '')
      .replace(/<script id="dc-prerender-swap"[\s\S]*?<\/script>/i, '');

    const snapshot =
      `\n<div id="dc-prerender">${cap.snapshot}</div>\n` +
      `<script id="dc-prerender-swap">` +
      `(function(){var p=document.getElementById('dc-prerender');if(!p)return;` +
      `var go=function(){if(p&&p.parentNode)p.parentNode.removeChild(p);};` +
      `var o=new MutationObserver(function(){var l=document.getElementById('dc-root');` +
      `if(l&&l.firstElementChild){o.disconnect();go();}});` +
      `o.observe(document.documentElement,{childList:true,subtree:true});` +
      `setTimeout(function(){o.disconnect();},15000);})();</script>\n`;

    // Place the snapshot right after the (hidden) template.
    bodyInner = /<\/x-dc>/i.test(bodyInner)
      ? bodyInner.replace(/(<\/x-dc>)/i, `$1${snapshot}`)
      : snapshot + bodyInner;

    const htmlAttrs = (original.match(/<html([^>]*)>/i) || [, ''])[1];
    const bodyAttrs = (original.match(/<body([^>]*)>/i) || [, ''])[1];

    const out =
      `<!DOCTYPE html>\n<html${htmlAttrs}>\n<head>\n${head}\n</head>\n` +
      `<body${bodyAttrs}>\n${bodyInner}\n</body>\n</html>\n`;

    fs.writeFileSync(htmlPath, out);
    console.log(`✓ pre-rendered snapshot baked into ${htmlFile} ` +
      `(${(cap.snapshot.length / 1024).toFixed(1)} KB of content${cap.hasFontFace ? ', fonts hoisted' : ''})`);
  } finally {
    await browser.close();
    server.close();
  }
}

// Run directly: `node prerender.mjs` (robust to spaces in the path)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prerender().catch((err) => { console.error('prerender failed:', err); process.exit(1); });
}

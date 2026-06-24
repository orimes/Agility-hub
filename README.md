# Agility Hub

Static site. `index.html` ships real, pre-rendered content on the first byte;
React, the `dc-runtime` client renderer, and fonts load as external, cacheable
files under `assets/`. JavaScript is progressive enhancement — the page is
readable (and indexable) without it.

## Background

The site previously shipped as a single self-extracting bundle: a JSON manifest
of gzip+base64 assets plus a JSON-encoded HTML template, unpacked at runtime by
inline JavaScript that decompressed everything (`DecompressionStream`), rebuilt
blob URLs, and replaced the whole document (`DOMParser` + `replaceWith`). That
meant no content until JS ran, no cacheable fonts, base64 size inflation, and an
invalid `<noscript>` inside `<head>`.

That bundle is now decoded ahead of time into static files, with three further
improvements baked into the build:

1. **Fonts** are emitted as external `assets/fonts/*.woff2` (cacheable, with
   `font-display: swap` and `unicode-range` subsetting preserved).
2. **React is self-hosted** under `assets/vendor/` — the site no longer depends
   on `unpkg.com` at runtime. (Babel is referenced by the runtime only for the
   live in-browser editor / `.jsx` components; it never loads on this deployed
   page.)
3. **Content is pre-rendered** into `index.html` as a static snapshot, so the
   header, hero, video library, and footer are visible to humans and crawlers
   before any JS runs. The `<x-dc>` template is kept intact; once `dc-runtime`
   boots it renders the live interactive app and removes the snapshot.

## Build

The original bundle is kept as `bundle.src.html` (the build input).

```sh
npm install        # once — installs puppeteer-core (drives system Chrome)
node build.mjs     # decode + self-host React + pre-render -> index.html + assets/
```

What runs:

- **`build.mjs`** — decodes each asset (gunzipping where needed), writes fonts
  and `assets/dc-runtime.js`, rewrites UUID placeholders to relative paths,
  vendors React into `assets/vendor/` (and points the runtime at it), injects a
  static `<title>`/description, then calls the pre-render step.
- **`prerender.mjs`** — loads the built page in headless Chrome (system Chrome
  via `puppeteer-core`; set `CHROME_PATH` to override), captures the rendered
  content + hoisted font/style `<head>`, and bakes the snapshot back into
  `index.html`. Re-run on its own with `node prerender.mjs`.

Pre-render needs a local Chrome. Without it, `build.mjs` still produces a valid
shell (it just prints a notice and skips the snapshot).

> Re-run the build whenever the source bundle or content changes, then commit
> the regenerated `index.html` + `assets/`.

## Serve

Any static host works:

```sh
python3 -m http.server 8000
```

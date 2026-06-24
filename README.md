# Agility Hub

Static site. `index.html` is plain semantic HTML served on the first byte; fonts
and the `dc-runtime` client renderer load as external, cacheable files under
`assets/`.

## Background

The site previously shipped as a single self-extracting bundle: a JSON manifest
of gzip+base64 assets plus a JSON-encoded HTML template, unpacked at runtime by
inline JavaScript that decompressed everything (`DecompressionStream`), rebuilt
blob URLs, and replaced the whole document (`DOMParser` + `replaceWith`). That
meant no content until JS ran, no cacheable fonts, base64 size inflation, and an
invalid `<noscript>` inside `<head>`.

The bundle is now decoded ahead of time into static files.

## Build

The original bundle is kept as `bundle.src.html` (the build input). Regenerate
`index.html` + `assets/` with Node (no dependencies):

```sh
node build.mjs
```

`build.mjs` decodes each asset (gunzipping where needed), writes fonts to
`assets/fonts/*.woff2` and the runtime to `assets/dc-runtime.js`, rewrites the
template's UUID placeholders to those relative paths, and injects a static
`<title>`/description.

## Serve

Any static host works:

```sh
python3 -m http.server 8000
```

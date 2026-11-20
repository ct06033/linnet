#!/usr/bin/env node
/**
 * W12a — generate electron-builder's Linux icon set: build/icons/{16,32,48,64,128,256,512}.png
 *
 * electron-builder's Linux icon-set resolver (app-builder-lib
 * util/iconConverter collectIconsFromDir) only recognizes files named
 * `^\d+(?:x\d+)?\.png$` inside `build/icons/` — the legacy flat
 * `build/icon-16.png` names are IGNORED, so builds shipped a single 512px
 * icon.png (or worse, the Electron default when icon.png were absent) and
 * GNOME fell back to the generic hamburger. 512.png is a byte-identical copy
 * of build/icon.png (already 512x512 RGBA — no resize needed, no deps); the
 * smaller sizes are byte-copies of the existing rev4 renderings, IHDR
 * dimensions verified — loud failure on any mismatch.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const iconsDir = path.join(build, "icons");
const SIZES = [16, 32, 48, 64, 128, 256, 512];

function pngDims(file) {
  const buf = readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`not a PNG: ${file}`);
  }
  // IHDR is always the first chunk: len(4) type(4) -> width(4) height(4) bitDepth(1) colorType(1)
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25] };
}

const master = path.join(build, "icon.png");
const md = pngDims(master);
if (md.w !== 512 || md.h !== 512) {
  throw new Error(`build/icon.png must be 512x512, got ${md.w}x${md.h}`);
}
if (md.colorType !== 6) {
  console.warn(`warn: build/icon.png colorType=${md.colorType} (expect 6 RGBA) — continuing`);
}

mkdirSync(iconsDir, { recursive: true });
const written = [];
for (const size of SIZES) {
  const out = path.join(iconsDir, `${size}.png`);
  const source = size === 512 ? master : path.join(build, `icon-${size}.png`);
  const d = pngDims(source);
  if (d.w !== size || d.h !== size) {
    throw new Error(`${source} is ${d.w}x${d.h}, expected ${size}x${size} — regenerate the icon set`);
  }
  copyFileSync(source, out);
  written.push(`${size}.png`);
}
console.log(`build/icons ready: ${written.join(", ")}`);

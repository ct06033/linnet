#!/usr/bin/env node
/**
 * asar-resolve-smoke — the gate that would have caught the v0.2.2 crash.
 *
 * Extracts resources/app.asar from built unpacked artifacts (win-unpacked,
 * linux-unpacked), collects every bare-specifier require() emitted into
 * dist-electron/*.js, and replays Node's REAL resolution (exports maps,
 * conditions) against the packaged node_modules. Any ERR_PACKAGE_PATH_NOT_EXPORTED
 * / MODULE_NOT_FOUND fails the run — which is exactly what "typecheck + vite
 * tests green" cannot see (v10 moduleResolution + ESM dev paths hide it).
 *
 * Usage: node scripts/asar-resolve-smoke.mjs [dir ...]
 *   dir = folder containing resources/app.asar (default: ../dist/*-unpacked)
 * Zero dependencies: parses the asar header directly.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function asarHeader(buf) {
  // Chromium pickle layout: [u32=4][u32=headerObjSize][u32=strPickleSize][u32=jsonLen][json...]
  const headerObjSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const json = buf.slice(16, 16 + jsonLen).toString("utf8");
  return { node: JSON.parse(json), dataStart: 8 + headerObjSize };
}

function walk(node, base = "", out = []) {
  for (const [name, ent] of Object.entries(node.files ?? {})) {
    const p = base ? `${base}/${name}` : name;
    if (ent.files) walk(ent, p, out);
    else if (!ent.unpacked) out.push([p, ent]);
  }
  return out;
}

function extractAll(asarPath, dest) {
  const buf = fs.readFileSync(asarPath);
  const { node, dataStart } = asarHeader(buf);
  fs.rmSync(dest, { recursive: true, force: true });
  for (const [p, ent] of walk(node)) {
    const out = path.join(dest, p);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf.subarray(dataStart + Number(ent.offset), dataStart + Number(ent.offset) + ent.size));
  }
}

const args = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.resolve(here, "../dist");
const candidates = args.length
  ? args
  : ["win-unpacked", "linux-unpacked"].map(d => path.join(dist, d)).filter(d => fs.existsSync(d));

if (candidates.length === 0) {
  console.error("asar-resolve-smoke: no *-unpacked dirs in", dist, "— run electron-builder --dir first");
  process.exit(2);
}

let failed = 0;
for (const dir of candidates) {
  const asar = path.join(dir, "resources", "app.asar");
  if (!fs.existsSync(asar)) { console.error(`MISSING ${asar}`); failed++; continue; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linnet-asar-smoke-"));
  extractAll(asar, tmp);
  const de = path.join(tmp, "dist-electron");
  const specs = new Map(); // specifier -> files requiring it
  for (const f of fs.readdirSync(de).filter(f => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(de, f), "utf8");
    for (const m of src.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
      const s = m[2];
      if (s.startsWith(".") || s === "electron" || s.startsWith("node:")) continue;
      if (!specs.has(s)) specs.set(s, []);
      specs.get(s).push(f);
    }
  }
  let bad = 0;
  for (const [spec, from] of specs) {
    // replay resolution exactly like the packaged main process would
    const probeFile = path.join(de, "__resolve_probe.js");
    for (const f of from) {
      try {
        const { createRequire } = await import("node:module");
        createRequire(path.join(de, f)).resolve(spec);
      } catch (e) {
        console.error(`FAIL  ${spec} (required by ${f}) -> ${e.code || ""} ${String(e.message).split("\n")[0]}`);
        bad++;
      }
    }
  }
  console.log(`${path.basename(dir)}: ${specs.size} packaged specifier(s) resolved, ${bad} failure(s)`);
  if (bad) failed++;
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

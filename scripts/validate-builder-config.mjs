#!/usr/bin/env node
// Validates apps/desktop/electron-builder.yaml WITHOUT running electron-builder.
// Wave-1 contract: Windows nsis x64 + Linux deb/rpm/AppImage, no macOS, directories.output=dist.
import { readFileSync } from "node:fs";
import YAML from "yaml";

const url = new URL("../apps/desktop/electron-builder.yaml", import.meta.url);
const doc = YAML.parse(readFileSync(url, "utf8"));
const errors = [];

if (!doc.appId) errors.push("appId missing");
if (doc.directories?.output !== "dist") {
  errors.push(`directories.output must be "dist", got ${JSON.stringify(doc.directories?.output)}`);
}

const winTargets = (doc.win?.target ?? []).map((t) => (typeof t === "string" ? { target: t } : t));
const nsis = winTargets.find((t) => t.target === "nsis");
if (!nsis) errors.push("win.target must include nsis");
else if (nsis.arch && !nsis.arch.includes("x64")) errors.push("win nsis target must build x64");

const linuxTargets = (doc.linux?.target ?? []).map((t) => (typeof t === "string" ? t : t.target));
for (const want of ["deb", "rpm", "AppImage"]) {
  if (!linuxTargets.includes(want)) errors.push(`linux.target must include ${want}`);
}

if (doc.mac || doc.dmg || doc.pkg) errors.push("macOS targets must not be configured in wave 1 (excluded by design)");

if (errors.length) {
  console.error("electron-builder.yaml INVALID:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("electron-builder.yaml OK (win nsis x64 + linux deb/rpm/AppImage, no macOS, output=dist)");

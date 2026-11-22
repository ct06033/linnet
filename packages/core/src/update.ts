/**
 * W18 — software update support (PRD §4 installers; "auto-update" P2 item).
 * Pure, host-agnostic helpers shared by the Electron main process
 * (apps/desktop updater), the renderer banner (packages/app) and tests.
 *
 * Two tiers:
 *  - Tier 1 (always): compare the running version against the latest GitHub
 *    release tag; surface a banner with a link to the release page.
 *  - Tier 2 (where the packaging allows): in-app download + install via
 *    electron-updater. Which formats support that is decided by
 *    updateCapability() — deb/rpm fall back to Tier 1 only.
 */

/** How far the update flow can go on the current build/OS combination. */
export type UpdateCapability = "install-in-app" | "announce-only";

/**
 * Normalized update state broadcast to the renderer. Main owns the machine;
 * the banner just renders whatever kind it last saw.
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; current: string; version: string; url: string; notes: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string; url: string }
  | { kind: "error"; message: string };

/** Snapshot `linnet:update-get` returns to the renderer on mount.
 *  `seq` is monotonic per app run: events and get-responses that carry an
 *  older seq than the renderer's current one are stale and must be dropped
 *  (an in-flight get() can otherwise clobber a fresher pushed event). */
export interface UpdateSnapshot {
  seq: number;
  state: UpdateState;
  current: string;
  capability: UpdateCapability;
  enabled: boolean;
}

/** "v0.2.1" / "V0.2.1 " / "0.2.1" -> "0.2.1"; non-string -> "". */
export function normalizeVersion(tag: unknown): string {
  if (typeof tag !== "string") return "";
  return tag.trim().replace(/^[vV]/, "");
}

/** "0.2.1" -> [0,2,1]; anything unparseable -> null. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(normalizeVersion(v));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True iff `latest` is strictly newer than `current` (numeric semver). */
export function isNewerVersion(current: unknown, latest: unknown): boolean {
  const a = parseSemver(typeof current === "string" ? current : "");
  const b = parseSemver(typeof latest === "string" ? latest : "");
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false; // equal
}

/**
 * Packaging capability from the runtime environment (Electron main):
 *  - Windows NSIS and Linux AppImage (running via the $APPIMAGE env the
 *    launcher sets) can download + install in-app via electron-updater.
 *  - deb/rpm (no APPIMAGE), dev builds and unsupported OSes stay announce-only
 *    — the banner links to the GitHub release instead.
 */
export function updateCapability(platform: string, env: Record<string, string | undefined> = {}): UpdateCapability {
  if (platform === "win32") return "install-in-app";
  if (platform === "linux" && typeof env.APPIMAGE === "string" && env.APPIMAGE.length > 0) {
    return "install-in-app";
  }
  return "announce-only";
}

/** GitHub releases API endpoint for the latest public release of a repo. */
export function latestReleaseApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** Fields the banner needs from a GitHub release JSON document. */
export interface ReleaseInfo {
  version: string;
  url: string;
  notes: string;
}

/**
 * Validate + reduce GitHub's release JSON to ReleaseInfo. Returns null when
 * the payload is not shaped like a release (also covers rate-limit errors,
 * drafts flagged as latest being absent, etc.).
 */
export function parseLatestRelease(json: unknown): ReleaseInfo | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const version = normalizeVersion(o.tag_name);
  if (!version || !parseSemver(version)) return null;
  const htmlUrl = typeof o.html_url === "string" && o.html_url.startsWith("https://") ? o.html_url : "";
  const notes = typeof o.body === "string" ? o.body : "";
  return { version, url: htmlUrl, notes };
}

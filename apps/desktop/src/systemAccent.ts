/**
 * W21 item 8: follow the Windows system accent color.
 *
 * Electron exposes no accent API, so we read the exact registry values the
 * Personalization pane writes: HKCU\Software\Microsoft\Windows\DWM
 *   AccentColor        REG_DWORD 0xAABBGGRR  (ABGR byte order!)
 *   EnableAccentColor  REG_DWORD 0|1         ("show accent color…")
 * Anything non-Windows, missing keys, or accents disabled => null (the CSS
 * default accent applies). Parsing is pure + unit-tested; only the reg.exe
 * call touches the system.
 */
import { execFileSync } from "node:child_process";

const KEY = "HKCU\\Software\\Microsoft\\Windows\\DWM";

/** ABGR DWORD → "#rrggbb". Windows packs B in bits 16-23, R in bits 0-7. */
export function abgrToHex(v: number): string {
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Parse the `reg query` stdout for both values; null = no usable accent. */
export function parseAccentQuery(accentStdout: string | null, enableStdout: string | null): string | null {
  if (!accentStdout) return null;
  const m = /AccentColor\s+REG_DWORD\s+0x([0-9a-fA-F]{1,8})/i.exec(accentStdout);
  if (!m) return null;
  // Respect the OS toggle: accents explicitly OFF means apps keep defaults.
  if (enableStdout !== null && /EnableAccentColor\s+REG_DWORD\s+0x0+\s*$/im.test(enableStdout)) return null;
  return abgrToHex(parseInt(m[1], 16));
}

function regQuery(value: "AccentColor" | "EnableAccentColor"): string | null {
  try {
    return execFileSync("reg", ["query", KEY, "/v", value], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Live read (win32 only). Fail-closed: any error yields null. */
export function getWindowsAccent(): string | null {
  if (process.platform !== "win32") return null;
  return parseAccentQuery(regQuery("AccentColor"), regQuery("EnableAccentColor"));
}

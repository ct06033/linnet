/**
 * W21 item 8: Windows DWM accent parsing — pure tests, no registry access.
 */
import { describe, expect, it } from "vitest";
import { abgrToHex, parseAccentQuery } from "./systemAccent.js";

const ACCENT_STDOUT =
  "HKCU\\Software\\Microsoft\\Windows\\DWM\r\n    AccentColor    REG_DWORD    0x2877ed\r\n\r\n";
const ENABLED =
  "HKCU\\Software\\Microsoft\\Windows\\DWM\r\n    EnableAccentColor    REG_DWORD    0x1\r\n\r\n";
const DISABLED =
  "HKCU\\Software\\Microsoft\\Windows\\DWM\r\n    EnableAccentColor    REG_DWORD    0x0\r\n\r\n";

describe("abgrToHex", () => {
  it("unpacks ABGR byte order (R in the LOW byte)", () => {
    expect(abgrToHex(0x0077ed)).toBe("#ed7700"); // B=00 G=77 R=ed
    expect(abgrToHex(0xff804020)).toBe("#204080"); // alpha ignored
    expect(abgrToHex(0)).toBe("#000000");
  });
});

describe("parseAccentQuery", () => {
  it("returns the hex when the accent exists and is enabled", () => {
    // 0x2877ed = ABGR: R=ed G=77 B=28
    expect(parseAccentQuery(ACCENT_STDOUT, ENABLED)).toBe("#ed7728");
  });
  it("respects the OS toggle: EnableAccentColor=0 means no follow", () => {
    expect(parseAccentQuery(ACCENT_STDOUT, DISABLED)).toBeNull();
  });
  it("missing values / error output => null (fail-closed)", () => {
    expect(parseAccentQuery(null, ENABLED)).toBeNull();
    expect(parseAccentQuery("ERROR: Unable to find the specified value.", ENABLED)).toBeNull();
    expect(parseAccentQuery(ACCENT_STDOUT, null)).not.toBeNull(); // toggle unknown -> still follow
  });
});

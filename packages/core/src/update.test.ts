import { describe, expect, it } from "vitest";
import {
  isNewerVersion,
  latestReleaseApiUrl,
  normalizeVersion,
  parseLatestRelease,
  parseSemver,
  updateCapability,
} from "./update.js";

describe("normalizeVersion", () => {
  it("strips v/V prefixes and whitespace", () => {
    expect(normalizeVersion("v0.2.1")).toBe("0.2.1");
    expect(normalizeVersion(" V10.0.0 ")).toBe("10.0.0");
    expect(normalizeVersion("0.2.1")).toBe("0.2.1");
  });
  it("returns empty for non-strings", () => {
    expect(normalizeVersion(undefined)).toBe("");
    expect(normalizeVersion(42)).toBe("");
  });
});

describe("parseSemver / isNewerVersion", () => {
  it("parses core triples, tolerating suffixes", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v0.10.2-rc1")).toEqual([0, 10, 2]);
    expect(parseSemver("nope")).toBeNull();
  });
  it("strictly orders versions", () => {
    expect(isNewerVersion("0.2.0", "v0.2.1")).toBe(true);
    expect(isNewerVersion("0.2.1", "0.2.1")).toBe(false);
    expect(isNewerVersion("0.3.0", "0.2.9")).toBe(false);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(true); // numeric, not lexical
    expect(isNewerVersion("0.2.1", "0.2.0")).toBe(false);
  });
  it("is false on garbage input (never nags the user on parse failure)", () => {
    expect(isNewerVersion("0.2.0", "nightly")).toBe(false);
    expect(isNewerVersion(undefined, "1.0.0")).toBe(false);
    expect(isNewerVersion("0.2.0", undefined)).toBe(false);
  });
});

describe("updateCapability", () => {
  it("Windows NSIS installs in-app", () => {
    expect(updateCapability("win32", {})).toBe("install-in-app");
  });
  it("Linux AppImage (launcher sets $APPIMAGE) installs in-app", () => {
    expect(updateCapability("linux", { APPIMAGE: "/home/u/Linnet-0.2.1-x86_64.AppImage" })).toBe("install-in-app");
  });
  it("deb/rpm, mac and dev builds are announce-only", () => {
    expect(updateCapability("linux", {})).toBe("announce-only");
    expect(updateCapability("linux", { APPIMAGE: "" })).toBe("announce-only");
    expect(updateCapability("darwin", {})).toBe("announce-only");
  });
});

describe("GitHub release JSON parsing", () => {
  it("builds the API url", () => {
    expect(latestReleaseApiUrl("ct06033/linnet")).toBe(
      "https://api.github.com/repos/ct06033/linnet/releases/latest",
    );
  });
  it("reduces a valid release", () => {
    const rel = parseLatestRelease({
      tag_name: "v0.2.1",
      html_url: "https://github.com/ct06033/linnet/releases/tag/v0.2.1",
      body: "notes here",
    });
    expect(rel).toEqual({
      version: "0.2.1",
      url: "https://github.com/ct06033/linnet/releases/tag/v0.2.1",
      notes: "notes here",
    });
  });
  it("rejects malformed payloads and non-semver tags", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease([])).toBeNull();
    expect(parseLatestRelease({ tag_name: "nightly" })).toBeNull();
    expect(parseLatestRelease({ tag_name: 3 })).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
  });
  it("still works without an html_url/body (link button just hides)", () => {
    const rel = parseLatestRelease({ tag_name: "1.0.0" });
    expect(rel).toEqual({ version: "1.0.0", url: "", notes: "" });
  });
});

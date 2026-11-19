/**
 * W6 N-rules — pure decision matrix (no client).
 */
import { describe, expect, it } from "vitest";
import { modeFor, shouldNotify, type Candidate, type NotifyPrefs } from "./model.js";

const base: Candidate = {
  roomId: "!r:hs.test",
  roomName: "r",
  isDM: false,
  sender: "@bob:hs.test",
  body: "hey",
  own: false,
  edit: false,
  redacted: false,
  mentionsYou: false,
  mentionsRoom: false,
};
const P = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({ modes: {}, keywords: [], ...over });

describe("shouldNotify", () => {
  it("N1: default mode 'all' notifies anything from others", () => {
    expect(shouldNotify(base, P())).toBe(true);
  });
  it("N2: mute suppresses everything, even mentions", () => {
    const prefs = P({ modes: { "!r:hs.test": "mute" } });
    expect(shouldNotify({ ...base, mentionsYou: true }, prefs)).toBe(false);
  });
  it("N3: mentions mode pings only mentions (m.mentions or @room)", () => {
    const prefs = P({ modes: { "!r:hs.test": "mentions" } });
    expect(shouldNotify(base, prefs)).toBe(false);
    expect(shouldNotify({ ...base, mentionsYou: true }, prefs)).toBe(true);
    expect(shouldNotify({ ...base, mentionsRoom: true }, prefs)).toBe(true);
  });
  it("N5: DMs always ping in mentions mode", () => {
    expect(shouldNotify({ ...base, isDM: true }, P({ modes: { "!r:hs.test": "mentions" } }))).toBe(true);
  });
  it("keywords fire even in mentions mode, case-insensitively", () => {
    const prefs = P({ modes: { "!r:hs.test": "mentions" }, keywords: ["Urgent"] });
    expect(shouldNotify({ ...base, body: "URGENT: deploy broke" }, prefs)).toBe(true);
    expect(shouldNotify({ ...base, body: "quiet news" }, prefs)).toBe(false);
  });
  it("own / edit / redacted never notify", () => {
    for (const over of [{ own: true }, { edit: true }, { redacted: true }] as const) {
      expect(shouldNotify({ ...base, ...over }, P())).toBe(false);
    }
  });
  it("modeFor defaults to all", () => {
    expect(modeFor(P(), "!r:hs.test")).toBe("all");
    expect(modeFor(P({ modes: { "!r:hs.test": "mute" } }), "!r:hs.test")).toBe("mute");
  });
});

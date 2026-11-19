import { describe, expect, it } from "vitest";
import { SendLedger, nextRetry, undoWindow } from "./sendstate.js";

describe("undoWindow", () => {
  it("allows within grace only", () => {
    const sent = { status: "sent" as const, eventKey: "k", startedAt: 0, sentAt: 1000 };
    expect(undoWindow(sent, 1500, 3000).allowed).toBe(true);
    expect(undoWindow(sent, 4501, 3000).allowed).toBe(false);
    expect(undoWindow({ status: "sending", eventKey: "k", startedAt: 0 }, 1000, 3000).allowed).toBe(false);
    expect(undoWindow(undefined, 0, 3000).allowed).toBe(false);
  });
});

describe("SendLedger", () => {
  it("tracks lifecycle", () => {
    const l = new SendLedger();
    l.start("k1", 0);
    expect(l.get("k1")!.status).toBe("sending");
    l.ack("k1", 10);
    expect(l.get("k1")!.status).toBe("sent");
    l.fail("k1", "boom");
    expect(l.get("k1")!.status).toBe("failed");
    l.cancel("k1");
    expect(l.get("k1")).toBeUndefined();
  });

  it("retry re-enters sending", () => {
    const l = new SendLedger();
    l.start("k2", 0);
    l.fail("k2", "net");
    const r = nextRetry(l.get("k2")!, 50);
    expect(r.status).toBe("sending");
    expect(r.startedAt).toBe(50);
  });
});

/**
 * W19 3a — email pusher module tests: pure helpers, and the full round-trip
 * through a REAL js-sdk client over the fake HS (validation mirrors
 * Synapse: 3PID-linked email required; CRUD visible via ctl).
 */
import { describe, expect, it } from "vitest";
import {
  emailAppId,
  emailPusherRequest,
  extractPrimaryEmail,
  isThreepidNotFound,
  EmailPusherManager,
} from "./emailPusher.js";
import { createClientSession } from "./sdk.js";
import { createFakeHomeserver, makeSyncSnapshot } from "./fake-homeserver.js";

describe("pure helpers", () => {
  it("app_id namespaces by device", () => {
    expect(emailAppId("ABC123")).toBe("chat.linnet.email.ABC123");
    expect(emailAppId("")).toBe("chat.linnet.email.default");
  });

  it("extractPrimaryEmail: verified wins over order", () => {
    expect(
      extractPrimaryEmail([
        { medium: "email", address: "old@x.test", verified: false },
        { medium: "email", address: "new@x.test", verified: true },
        { medium: "msisdn", address: "447700900123" },
      ]),
    ).toEqual({ address: "new@x.test", verified: true });
    expect(extractPrimaryEmail([{ medium: "email", address: "a@x.test" }])).toEqual({
      address: "a@x.test",
      verified: false,
    });
    expect(extractPrimaryEmail([{ medium: "msisdn", address: "1" }])).toBeNull();
    expect(extractPrimaryEmail([])).toBeNull();
  });

  it("emailPusherRequest matches the Synapse shape", () => {
    const req = emailPusherRequest("s@x.test", "DEV1", "Linnet on DEV1");
    expect(req.kind).toBe("email");
    expect(req.pushkey).toBe("s@x.test");
    expect(req.app_id).toBe("chat.linnet.email.DEV1");
    expect(req.data).toEqual({});
  });

  it("isThreepidNotFound reads MatrixError shapes", () => {
    expect(isThreepidNotFound({ errcode: "M_THREEPID_NOT_FOUND" })).toBe(true);
    expect(isThreepidNotFound({ data: { errcode: "M_THREEPID_NOT_FOUND" } })).toBe(true);
    expect(isThreepidNotFound({ http_status: 400, message: "Email not found" })).toBe(true);
    expect(isThreepidNotFound({ errcode: "M_FORBIDDEN" })).toBe(false);
    expect(isThreepidNotFound(new Error("boom"))).toBe(false);
  });
});

describe("EmailPusherManager over fake HS (real js-sdk)", () => {
  const ALICE = { userId: "@alice:hs.test", password: "pw", accessToken: "tok-alice" };

  function client() {
    const fetchFn = createFakeHomeserver({
      accounts: [ALICE],
      sync: () => makeSyncSnapshot({ userId: ALICE.userId, rooms: [] }),
    });
    const clientInst = createClientSession({
      homeserverUrl: "https://hs.test",
      accessToken: ALICE.accessToken,
      deviceId: "DEV1",
      userId: ALICE.userId,
      fetchFn,
    });
    return { fetchFn, ctl: fetchFn.controls, mgr: new EmailPusherManager(clientInst) };
  }

  it("enable -> registered, status on; disable -> gone, status off", async () => {
    const { ctl, mgr } = client();
    ctl.seedThreepids(ALICE.userId, [{ medium: "email", address: "s@x.test", verified: true }]);

    expect(await mgr.status()).toEqual({ kind: "off" });
    await mgr.enable("s@x.test", "DEV1", "desktop");
    expect(await mgr.status()).toEqual({ kind: "on", email: "s@x.test" });
    // rules bootstrap: enabling must pull the server ruleset (lazy Synapse
    // materialisation — without it no push actions, hence no digests, EVER)
    expect(ctl.calls.some((c) => c.method === "GET" && /\/pushrules/.test(c.path))).toBe(true);

    const stored = ctl.pushersFor(ALICE.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.kind).toBe("email");
    expect(stored[0]!.pushkey).toBe("s@x.test");
    expect(stored[0]!.app_id).toBe("chat.linnet.email.DEV1");

    await mgr.disable("DEV1");
    expect(await mgr.status()).toEqual({ kind: "off" });
    expect(ctl.pushersFor(ALICE.userId)).toHaveLength(0);
  });

  it("unlinked email is rejected exactly like Synapse (M_THREEPID_NOT_FOUND)", async () => {
    const { mgr } = client();
    await mgr.enable("stranger@x.test", "DEV1", "desktop").then(
      () => expect.unreachable("should have rejected"),
      (e: unknown) => expect(isThreepidNotFound(e)).toBe(true),
    );
  });

  it("foreign email pusher (another client) surfaces as 'foreign', not ours", async () => {
    const { fetchFn, ctl, mgr } = client();
    ctl.seedThreepids(ALICE.userId, [{ medium: "email", address: "s@x.test" }]);
    await fetchFn("https://hs.test/_matrix/client/v3/pushers/set", {
      method: "POST",
      headers: { Authorization: `Bearer ${ALICE.accessToken}` },
      body: JSON.stringify({
        kind: "email",
        app_id: "im.element.web.email.DEV9",
        app_display_name: "Element",
        device_display_name: "chrome",
        pushkey: "s@x.test",
        lang: "en",
        data: {},
      }),
    });
    expect(await mgr.status()).toEqual({ kind: "foreign", email: "s@x.test" });
    await mgr.disable("DEV1"); // must not delete the other client's pusher
    expect(ctl.pushersFor(ALICE.userId)).toHaveLength(1);
  });
});

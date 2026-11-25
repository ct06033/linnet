import { describe, expect, it } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { createClientSession } from "./sdk.js";
import { rememberBootstrapKey, setUnlockedSsssKey } from "./e2ee.js";

describe("createClientSession", () => {
  it("builds a MatrixClient against the homeserver", () => {
    const client = createClientSession({
      homeserverUrl: "https://matrix.example",
      accessToken: "syt_test",
      deviceId: "TESTDEV",
    });
    expect(client.getHomeserverUrl()).toBe("https://matrix.example");
    expect(client.getAccessToken()).toBe("syt_test");
  });
  it("rejects non-http homeserver", () => {
    expect(() => createClientSession({ homeserverUrl: "matrix.example" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// W14: the client-level getSecretStorageKey callback must serve BOTH the
// mid-bootstrap holder key and the user-unlocked key (the falsey-return crash
// on accounts with existing SSSS lived exactly here), preferring the account's
// default key id among the advertised keys.
type SSSSCallback = (
  o: { keys: Record<string, unknown> },
  name: string,
) => Promise<[string, Uint8Array<ArrayBuffer>] | null>;

function callbackOf(client: MatrixClient): SSSSCallback {
  return (
    client as unknown as { cryptoCallbacks: { getSecretStorageKey: SSSSCallback } }
  ).cryptoCallbacks.getSecretStorageKey;
}

function seedDefaultKey(client: MatrixClient, keyId: string | null): void {
  const content = keyId ? { key: keyId } : undefined;
  // W22: pickSsssKeyId reads m.secret_storage.default_key FROM THE SERVER first
  // (fresh-session race fix); fall back to the local cache stub when it is gone.
  (client as unknown as { getAccountDataFromServer: (t: string) => Promise<Record<string, unknown> | null> })
    .getAccountDataFromServer = async (t: string) =>
    t === "m.secret_storage.default_key" && content ? content : null;
  (client as unknown as { getAccountData: (t: string) => { getContent: () => unknown } | undefined }).getAccountData =
    (t: string) =>
      t === "m.secret_storage.default_key" && keyId ? { getContent: () => ({ key: keyId }) } : undefined;
}

describe("W14 getSecretStorageKey callback", () => {
  it("returns null when no key is known (pre-fix crash source)", async () => {
    const c = createClientSession({ homeserverUrl: "https://hs.test", accessToken: "t", deviceId: "D", userId: "@a:hs.test" });
    seedDefaultKey(c, null);
    await expect(callbackOf(c)({ keys: { AAA: {} } }, "m.cross_signing.master")).resolves.toBeNull();
  });

  it("serves the bootstrap-holder key and prefers the default key id", async () => {
    const c = createClientSession({ homeserverUrl: "https://hs.test", accessToken: "t", deviceId: "D", userId: "@a:hs.test" });
    const k1 = new Uint8Array(32).fill(1);
    rememberBootstrapKey(c, k1);
    seedDefaultKey(c, "DEF");
    const r = await callbackOf(c)({ keys: { AAA: {}, DEF: {} } }, "m.cross_signing.master");
    expect(r).not.toBeNull();
    expect(r![0]).toBe("DEF");
    expect(r![1]).toBe(k1);
  });

  it("falls back to the first advertised id when the default key is absent from keys", async () => {
    const c = createClientSession({ homeserverUrl: "https://hs.test", accessToken: "t", deviceId: "D", userId: "@a:hs.test" });
    seedDefaultKey(c, "ZZZ");
    const k2 = new Uint8Array(32).fill(2);
    setUnlockedSsssKey(c, k2);
    const r = await callbackOf(c)({ keys: { AAA: {}, BBB: {} } }, "m.cross_signing.master");
    expect(r).not.toBeNull();
    expect(r![0]).toBe("AAA");
    expect(r![1]).toBe(k2);
  });

  it("bootstrap key wins over the unlocked key when both exist", async () => {
    const c = createClientSession({ homeserverUrl: "https://hs.test", accessToken: "t", deviceId: "D", userId: "@a:hs.test" });
    seedDefaultKey(c, null);
    const kb = new Uint8Array(32).fill(7);
    rememberBootstrapKey(c, kb);
    setUnlockedSsssKey(c, new Uint8Array(32).fill(8));
    const r = await callbackOf(c)({ keys: { AAA: {} } }, "m.cross_signing.master");
    expect(r![1]).toBe(kb);
  });
});

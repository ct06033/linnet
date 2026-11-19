import { describe, expect, it } from "vitest";
import { createClientSession } from "./sdk.js";

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

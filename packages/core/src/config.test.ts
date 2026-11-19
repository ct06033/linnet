import { describe, expect, it } from "vitest";
import { discoverHomeserver, parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    expect(parseConfig('{"defaultHomeServer":"https://synapse.local","modules":{"demo":false}}')).toEqual({
      defaultHomeServer: "https://synapse.local",
      modules: { demo: false },
    });
  });
  it("rejects non-object / bad types", () => {
    expect(() => parseConfig("[]")).toThrow();
    expect(() => parseConfig('{"modules":true}')).toThrow();
    expect(() => parseConfig('{"modules":{"a":"yes"}}')).toThrow();
  });
});

describe("discoverHomeserver", () => {
  it("returns base_url on good well-known", async () => {
    const fake = (async (_url: unknown) => ({
      ok: true,
      json: async () => ({ "m.homeserver": { base_url: "https://hs.example" } }),
    })) as unknown as typeof fetch;
    expect(await discoverHomeserver("example", fake)).toBe("https://hs.example");
  });
  it("nulls out gracefully", async () => {
    const bad = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await discoverHomeserver("example", bad)).toBeNull();
    const miss = (async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await discoverHomeserver("example", miss)).toBeNull();
  });
});

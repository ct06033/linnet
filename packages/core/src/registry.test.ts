import { describe, expect, it } from "vitest";
import { ModuleRegistry, type LinnetModule } from "./registry.js";

const demo: LinnetModule = {
  id: "demo",
  contributions: () => [
    { slot: "slash-command", command: "/echo", run: (a) => a },
    { slot: "event-handler", event: "room.open", handler: () => {} },
  ],
};

describe("ModuleRegistry", () => {
  it("registers and lists by slot", async () => {
    const r = new ModuleRegistry({ flags: {}, config: {} });
    await r.register(demo);
    expect(r.list("slash-command").map((c) => c.command)).toEqual(["/echo"]);
    expect(r.moduleIds()).toEqual(["demo"]);
  });

  it("rejects duplicate ids", async () => {
    const r = new ModuleRegistry({ flags: {}, config: {} });
    await r.register(demo);
    await expect(r.register(demo)).rejects.toThrow(/already registered/);
  });

  it("enable/disable filters contributions", async () => {
    const r = new ModuleRegistry({ flags: {}, config: {} });
    await r.register(demo);
    r.disable("demo");
    expect(r.list("slash-command")).toHaveLength(0);
    expect(r.isEnabled("demo")).toBe(false);
    r.enable("demo");
    expect(r.list("slash-command")).toHaveLength(1);
    expect(() => r.enable("ghost")).toThrow(/not registered/);
  });

  it("flag gating skips contributions", async () => {
    const r = new ModuleRegistry({ flags: { beta: false }, config: {} });
    await r.register({ ...demo, id: "gated", flags: ["beta"] });
    expect(r.list("slash-command")).toHaveLength(0);
  });

  it("lazy registration via dynamic loader", async () => {
    const r = new ModuleRegistry({ flags: {}, config: {} });
    await r.registerLazy("late", async () => ({ default: demo }));
    expect(r.moduleIds()).toContain("late");
  });

  it("dispatches events only while enabled", async () => {
    const hits: unknown[] = [];
    const r = new ModuleRegistry({ flags: {}, config: {} });
    await r.register({
      id: "spy",
      contributions: () => [
        { slot: "event-handler", event: "x", handler: (p) => hits.push(p) },
      ],
    });
    r.dispatch("x", 1);
    r.disable("spy");
    r.dispatch("x", 2);
    expect(hits).toEqual([1]);
  });
});

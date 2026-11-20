/**
 * W5a E2EE-UI: wizard + recovery reducers (pure), SecuritySheet flows against
 * a mocked adapter, banner statuses, RoomView wiring (banner click + UTD
 * help link) against the fake homeserver.
 */
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeEventLike,
  type FakeHomeserverControls,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";
import { wizardInitial, wizardReduce, type WizardStep } from "./state.js";
import { restoreInitial, restoreReduce, type RestoreStep } from "./state.js";
import { unlockInitial, unlockReduce, type UnlockStep } from "./state.js";
import { SecuritySheet, SecurityBanner, type SecurityAdapter, type VerifyHandle } from "./Security.js";
import type { SecurityStatus } from "./state.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

// ---------------------------------------------------------------- reducers

describe("W5a wizard reducer", () => {
  it("walks intro->done with ack gate and passphrase strength gate", () => {
    let s: WizardStep = wizardReduce(wizardInitial, { t: "begin" });
    expect(s.step).toBe("credentials");
    s = wizardReduce(s, { t: "password", value: "hunter2" });
    expect(s.step).toBe("credentials"); // typing stays put
    s = wizardReduce(s, { t: "credsNext" });
    expect(s.step).toBe("keymode");
    s = wizardReduce(s, { t: "choose", mode: "passphrase", passphrase: "short" });
    expect(s.step).toBe("keymode"); // <8 blocked
    s = wizardReduce(s, { t: "choose", mode: "passphrase", passphrase: "long enough" });
    expect(s.step).toBe("working");
    s = wizardReduce(s, { t: "success", recoveryKey: "KEY-ABC" });
    expect(s.step).toBe("showKey");
    s = wizardReduce(s, { t: "ack" });
    expect(s.step).toBe("done");
  });

  it("error keeps the working params for retry", () => {
    let s: WizardStep = { step: "working", password: "p1", passphrase: "passphrase1" };
    s = wizardReduce(s, { t: "fail", message: "boom" });
    expect(s.step).toBe("error");
    s = wizardReduce(s, { t: "retry" });
    expect(s).toEqual({ step: "working", password: "p1", passphrase: "passphrase1" });
  });
});

describe("W5a restore reducer", () => {
  it("route -> input -> progress -> done", () => {
    let s: RestoreStep = restoreReduce(restoreInitial, { t: "pick", route: "passphrase" });
    s = restoreReduce(s, { t: "value", value: "secret words" });
    s = restoreReduce(s, { t: "submit" });
    expect(s.step).toBe("working");
    s = restoreReduce(s, { t: "progress", total: 10, imported: 3 });
    expect(s.step).toBe("progress");
    s = restoreReduce(s, { t: "done", imported: 10 });
    expect(s).toEqual({ step: "done", imported: 10 });
  });

  it("empty value cannot submit; bad secret errors then retries to working", () => {
    let s: RestoreStep = restoreReduce(restoreInitial, { t: "pick", route: "key" });
    s = restoreReduce(s, { t: "submit" });
    expect(s.step).toBe("input");
    s = restoreReduce(s, { t: "value", value: "abc" });
    s = restoreReduce(s, { t: "submit" });
    s = restoreReduce(s, { t: "fail", message: "bad decrypt" });
    expect(s.step).toBe("error");
    s = restoreReduce(s, { t: "retry" });
    expect(s.step).toBe("working");
  });
});

describe("W14 unlock reducer", () => {
  it("walks route -> input -> working -> progress -> done(imported)", () => {
    let s: UnlockStep = unlockReduce(unlockInitial, { t: "pick", route: "passphrase" });
    expect(s.step).toBe("input");
    s = unlockReduce(s, { t: "value", value: "right passphrase here" });
    s = unlockReduce(s, { t: "submit" });
    expect(s.step).toBe("working");
    s = unlockReduce(s, { t: "progress", total: 12, imported: 5 });
    expect(s.step).toBe("progress");
    if (s.step !== "progress") throw new Error("unreachable");
    expect(s.total).toBe(12);
    expect(s.imported).toBe(5);
    s = unlockReduce(s, { t: "done", imported: 12 });
    expect(s).toEqual({ step: "done", imported: 12 });
  });

  it("empty input cannot submit; error keeps params for retry; again resets", () => {
    let s: UnlockStep = unlockReduce(unlockInitial, { t: "pick", route: "key" });
    s = unlockReduce(s, { t: "submit" });
    expect(s.step).toBe("input"); // empty value blocked
    s = unlockReduce(s, { t: "value", value: "Key ABC" });
    s = unlockReduce(s, { t: "submit" });
    s = unlockReduce(s, { t: "fail", message: "wrong passphrase or recovery key" });
    expect(s.step).toBe("error");
    s = unlockReduce(s, { t: "retry" });
    expect(s).toEqual({ step: "working", route: "key", value: "Key ABC" });
    s = unlockReduce(s, { t: "fail", message: "boom" });
    expect(unlockReduce(s, { t: "again" })).toEqual({ step: "route" });
  });
});

// ---------------------------------------------------------------- sheet UI

function mockAdapter(over: Partial<SecurityAdapter> = {}): SecurityAdapter & { calls: string[] } {
  const calls: string[] = [];
  let ready = false;
  let incomingCb: ((h: VerifyHandle, request: unknown) => void) | null = null;
  const a: SecurityAdapter & { calls: string[] } = {
    calls,
    get incoming() {
      return incomingCb;
    },
    async bootstrap() {
      calls.push("bootstrap");
      ready = true;
      return "RecoveryKeyABC 1234";
    },
    async restorePassphrase(_c, _p, onProgress) {
      calls.push("restore-pass");
      onProgress({ total: 10, imported: 3 });
      return 10;
    },
    async restoreRecoveryKey() {
      calls.push("restore-key");
      return 4;
    },
    async unlock({ onProgress }) {
      calls.push("unlock");
      onProgress({ total: 4, imported: 4 });
      return 4;
    },
    async status(): Promise<SecurityStatus> {
      return { cryptoAvailable: true, ready, ssssReady: ready, crossSigningReady: ready, backupEnabled: true, backupCount: 7 };
    },
    async runBackup() {
      calls.push("runBackup");
    },
    async sessions() {
      calls.push("sessions");
      return [
        { deviceId: "CUR", name: "this session", lastSeen: "today", ip: "10.0.0.1", verified: true, current: true },
        { deviceId: "OLD", name: "old phone", lastSeen: "yesterday", ip: undefined, verified: false, current: false },
      ];
    },
    async beginDeviceVerification(_c, id) {
      calls.push(`verify:${id}`);
      return fakeHandle();
    },
    async revoke(_c, id) {
      calls.push(`revoke:${id}`);
    },
    async logoutAll() {
      calls.push("logoutAll");
    },
    onIncomingRequest(_c, cb) {
      incomingCb = cb;
      return () => {
        incomingCb = null;
      };
    },
    ...over,
  };
  return a;
}

function fakeHandle(): VerifyHandle {
  let settle: (r: "done" | "cancelled") => void = () => undefined;
  const fin = new Promise<"done" | "cancelled">((res) => {
    settle = res;
  });
  return {
    entries: () =>
      Promise.resolve([
        { emoji: ["🐶"], description: "Dog" },
        { emoji: ["🌳"], description: "Tree" },
        { emoji: ["🎸"], description: "Guitar" },
      ]),
    confirm: () => {
      settle("done");
      return Promise.resolve();
    },
    cancel: () => {
      settle("cancelled");
      return Promise.resolve();
    },
    finished: () => fin,
  };
}

const anyClient = { getUserId: () => ALICE.userId } as unknown as MatrixClient;

describe("W5a SecuritySheet", () => {
  it("setup wizard reaches recovery key and gates Done behind acknowledgment", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    await screen.findByTestId("security-status");
    fireEvent.click(screen.getByTestId("start-setup"));
    fireEvent.click(screen.getByTestId("wizard-begin"));
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("wizard-creds-next"));
    // auto mode default
    fireEvent.click(screen.getByTestId("wizard-go"));
    const key = await screen.findByTestId("recovery-key");
    expect(key.textContent).toBe("RecoveryKeyABC 1234");
    expect((screen.getByTestId("wizard-ack-done") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I have saved my recovery key/));
    fireEvent.click(screen.getByTestId("wizard-ack-done"));
    expect(adapter.calls).toContain("bootstrap");
  });

  it("wizard failure shows the reason and retry re-runs", async () => {
    let first = true;
    const adapter = mockAdapter({
      async bootstrap() {
        if (first) {
          first = false;
          throw new Error("UIA rejected");
        }
        return "KEY2";
      },
    });
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-setup"));
    fireEvent.click(screen.getByTestId("wizard-begin"));
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("wizard-creds-next"));
    fireEvent.click(screen.getByTestId("wizard-go"));
    expect((await screen.findByTestId("wizard-error")).textContent).toContain("UIA rejected");
    fireEvent.click(screen.getByTestId("wizard-retry"));
    expect((await screen.findByTestId("recovery-key")).textContent).toBe("KEY2");
  });

  it("passphrase mode rejects short passphrases client-side", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-setup"));
    fireEvent.click(screen.getByTestId("wizard-begin"));
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("wizard-creds-next"));
    fireEvent.click(screen.getByLabelText(/Choose a security passphrase/));
    fireEvent.change(screen.getByTestId("wizard-passphrase"), { target: { value: "short" } });
    expect((screen.getByTestId("wizard-go") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("wizard-passphrase"), { target: { value: "long enough 8+" } });
    expect((screen.getByTestId("wizard-go") as HTMLButtonElement).disabled).toBe(false);
  });

  it("recovery by passphrase shows progress then imported count", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-recover"));
    fireEvent.click(screen.getByTestId("recover-pass"));
    fireEvent.change(screen.getByTestId("recover-input"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByTestId("recover-go"));
    expect((await screen.findByTestId("recover-done")).textContent).toContain("Imported 10");
    expect(adapter.calls).toContain("restore-pass");
  });

  it("back up now hits the backup trigger", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    const btn = await screen.findByTestId("backup-now");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(adapter.calls).toContain("runBackup"));
  });

  it("sessions list: verified tags, verify button drives SAS to done", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-sessions"));
    const row = await screen.findByTestId("session-OLD");
    expect(row.textContent).toContain("unverified");
    expect(screen.getByTestId("session-CUR").textContent).toContain("✓ verified");
    fireEvent.click(screen.getByTestId("verify-OLD"));
    expect(adapter.calls).toContain("verify:OLD");
    await screen.findByTestId("sas-entries");
    expect(document.querySelectorAll(".sas-emojis li")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("sas-match"));
    await screen.findByTestId("sas-done");
  });

  it("SAS mismatch cancels", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-sessions"));
    fireEvent.click(await screen.findByTestId("verify-OLD"));
    await screen.findByTestId("sas-entries");
    fireEvent.click(screen.getByTestId("sas-nomatch"));
    await screen.findByTestId("sas-cancelled");
  });

  it("revoke asks for a password and calls the adapter", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-sessions"));
    fireEvent.click(await screen.findByTestId("revoke-OLD"));
    fireEvent.change(screen.getByTestId("revoke-pw-OLD"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("revoke-go-OLD"));
    await waitFor(() => expect(adapter.calls).toContain("revoke:OLD"));
  });

  it("W4 sign out all other sessions hits logoutAll (no password prompt)", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-sessions"));
    fireEvent.click(await screen.findByTestId("logout-all"));
    await waitFor(() => expect(adapter.calls).toContain("logoutAll"));
  });

  it("incoming verification takes over the panel from any flow", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    await screen.findByTestId("security-status");
    const cb = (adapter as unknown as { incoming: (h: VerifyHandle) => void }).incoming;
    cb!(fakeHandle());
    const panel = await screen.findByTestId("incoming-verify");
    expect(panel.textContent).toContain("Compare");
    await waitFor(() => expect(screen.getByTestId("sas-entries")).toBeTruthy());
  });

  it("current session has no revoke button", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("start-sessions"));
    await screen.findByTestId("session-CUR");
    expect(screen.queryByTestId("revoke-CUR")).toBeNull();
    expect(screen.queryByTestId("verify-CUR")).toBeNull();
  });

  it("item 9: security/recover dialog is centered + high-contrast in both themes", async () => {
    const adapter = mockAdapter();
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    const status = await screen.findByTestId("security-status");
    const dialog = status.closest(".sheet") as HTMLElement;
    expect(dialog.getAttribute("data-position")).toBe("center");
    expect(dialog.getAttribute("data-contrast")).toBe("wcag");
    expect(dialog.className).toContain("hc");
    // the Recover flow itself carries the contrast markers
    fireEvent.click(screen.getByTestId("start-recover"));
    const flow = await screen.findByTestId("recover");
    expect(flow.className).toContain("hc");
    expect(flow.getAttribute("data-contrast")).toBe("wcag");
    // CSS contract: elevated surfaces are DEFINED for both themes (light
    // defaults used to fall through to dark hexes = the unreadability bug)
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/:root\s*\{[^}]*--bg-elev:/s);
    expect(css).toMatch(/\[data-theme="dark"\]\s*\{[^}]*--bg-elev:/);
    expect(css).toMatch(/:root:not\(\[data-theme\]\)\s*\{[^}]*--bg-elev:/);
    // UTD + recover & verify text no longer sits at 60% opacity, and the help
    // link uses the theme-aware accent link
    expect(css).toMatch(/\.msg-redacted, \.msg-utd \{ opacity: \.85/);
    expect(css).toMatch(/\.utd-help \{[^}]*var\(--accent-link/);
  });
});

// ---------------------------------------------------------------- W14 unlock
// Accounts that ALREADY have Secure Secret Storage must NOT be offered the
// setup wizard (that was the "getSecretStorageKey callback returned falsey"
// crash) — they get the unlock-session nudge + flow instead.

function lockedSsssStatus(unlocked: boolean): SecurityStatus {
  return {
    cryptoAvailable: true, ready: unlocked, ssssReady: true, crossSigningReady: unlocked,
    backupEnabled: true, backupCount: unlocked ? 6 : 0,
  };
}

describe("W14 SecuritySheet unlock-session", () => {
  it("ssssReady && !ready: unlock nudge replaces the setup wizard", async () => {
    let unlocked = false;
    const adapter = mockAdapter({ status: async () => lockedSsssStatus(unlocked) });
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    const nudge = await screen.findByTestId("ssss-warning");
    expect(nudge.textContent).toContain("already has Secure Secret Storage");
    expect(screen.getByTestId("unlock-session")).toBeTruthy();
    expect(screen.queryByTestId("start-setup")).toBeNull();
    // "Recover encrypted history" stays available for unlocked sessions too
    expect(screen.getByTestId("start-recover")).toBeTruthy();
    expect(unlocked).toBe(false);
  });

  it("!ssssReady keeps the setup wizard (no unlock nudge)", async () => {
    const adapter = mockAdapter({
      status: async () => ({
        cryptoAvailable: true, ready: false, ssssReady: false, crossSigningReady: false,
        backupEnabled: false, backupCount: null,
      }),
    });
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    await screen.findByTestId("start-setup");
    expect(screen.queryByTestId("unlock-session")).toBeNull();
    expect(screen.queryByTestId("ssss-warning")).toBeNull();
  });

  it("happy flow: nudge -> passphrase -> progress -> done(imported); close refreshes to ready", async () => {
    let unlocked = false;
    let release!: () => void;
    const adapter = mockAdapter({
      status: async () => lockedSsssStatus(unlocked),
      unlock: async ({ secret, onProgress }) => {
        expect(secret).toEqual({ passphrase: "right passphrase here" });
        onProgress({ total: 6, imported: 2 });
        return new Promise<number>((res) => {
          release = () => {
            unlocked = true;
            res(6);
          };
        });
      },
    });
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("unlock-session"));
    fireEvent.click(screen.getByTestId("unlock-route-pass"));
    expect(screen.getByLabelText("Security passphrase")).toBeTruthy();
    fireEvent.change(screen.getByTestId("unlock-input"), { target: { value: "right passphrase here" } });
    fireEvent.click(screen.getByTestId("unlock-go"));
    const prog = await screen.findByTestId("unlock-progress");
    expect(prog.textContent).toContain("Importing 2/6");
    await act(async () => {
      release();
    });
    const done = await screen.findByTestId("unlock-done");
    expect(done.textContent).toContain("Unlocked");
    expect(done.textContent).toContain("Imported 6");
    fireEvent.click(screen.getByTestId("unlock-close"));
    await waitFor(() => expect(screen.getByTestId("security-status").textContent).toContain("on"));
  });

  it("recovery-key route: text input + right secret shape", async () => {
    const adapter = mockAdapter({
      status: async () => lockedSsssStatus(false),
      unlock: async ({ secret }) => {
        expect(secret).toEqual({ recoveryKey: "foo bar key" });
        return 3;
      },
    });
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("unlock-session"));
    fireEvent.click(screen.getByTestId("unlock-route-key"));
    const input = screen.getByLabelText("Recovery key") as HTMLInputElement;
    expect(input.type).toBe("text");
    fireEvent.change(screen.getByTestId("unlock-input"), { target: { value: "foo bar key" } });
    fireEvent.click(screen.getByTestId("unlock-go"));
    expect((await screen.findByTestId("unlock-done")).textContent).toContain("Imported 3");
  });

  it("wrong secret shows the reason + retry re-runs and succeeds", async () => {
    let first = true;
    const adapter = mockAdapter({
      status: async () => lockedSsssStatus(false),
      unlock: async () => {
        if (first) {
          first = false;
          throw new Error("wrong passphrase or recovery key");
        }
        return 3;
      },
    });
    render(<SecuritySheet client={anyClient} adapter={adapter} onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("unlock-session"));
    fireEvent.click(screen.getByTestId("unlock-route-pass"));
    fireEvent.change(screen.getByTestId("unlock-input"), { target: { value: "typo passphrase" } });
    fireEvent.click(screen.getByTestId("unlock-go"));
    const err = await screen.findByTestId("unlock-error");
    expect(err.textContent).toContain("wrong passphrase or recovery key");
    fireEvent.click(screen.getByTestId("unlock-retry"));
    expect((await screen.findByTestId("unlock-done")).textContent).toContain("Imported 3");
  });
});

describe("W5a banner", () => {
  it("maps status to labels", () => {
    const { unmount } = render(
      <SecurityBanner
        encrypted
        status={{ cryptoAvailable: true, ready: true, ssssReady: true, crossSigningReady: true, backupEnabled: true, backupCount: 1 }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByTestId("security-banner").textContent).toContain("Secured");
    unmount();
    render(
      <SecurityBanner
        encrypted
        status={{ cryptoAvailable: true, ready: false, ssssReady: false, crossSigningReady: false, backupEnabled: false, backupCount: null }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByTestId("security-banner").textContent).toContain("Set up encryption");
  });

  it("non-encrypted room shows nothing", () => {
    render(<SecurityBanner encrypted={false} status={null} onClick={() => undefined} />);
    expect(screen.queryByTestId("security-banner")).toBeNull();
  });
});

// ------------------------------------------------------- App wiring (fake HS)

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };
let events: FakeEventLike[];

function freshManager(): SessionManager {
  events = [];
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!sec:hs.test",
            name: "secure-room",
            encrypted: true,
            members: { [BOB]: "join", [ALICE.userId]: "join" },
            events: [
              {
                type: "m.room.encrypted",
                sender: BOB,
                content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "xx", sender_key: "aa", session_id: "s" },
                event_id: "$utd1",
                origin_server_ts: 1000,
              },
            ],
          },
        ],
      }),
  }) as typeof globalThis.fetch & { controls: FakeHomeserverControls };
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function openSecureRoom(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const matches = await screen.findAllByText("secure-room");
  fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
  await screen.findByTestId("roomview");
}

describe("W5a room wiring", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("banner appears in encrypted room; click opens the sheet (degraded honestly without crypto)", async () => {
    await openSecureRoom();
    const banner = await screen.findByTestId("security-banner");
    expect(banner.textContent).toContain("🔒");
    fireEvent.click(banner);
    const sheet = await screen.findByTestId("security-sheet");
    expect(sheet.textContent).toContain("Security & encryption");
    fireEvent.click(screen.getByTestId("sheet-close"));
    await waitFor(() => expect(screen.queryByTestId("security-sheet")).toBeNull());
  });

  it("UTD tile offers recover & verify which opens the sheet", async () => {
    await openSecureRoom();
    const help = await screen.findByTestId("utd-help");
    fireEvent.click(help);
    expect(await screen.findByTestId("security-sheet")).toBeTruthy();
  });
});

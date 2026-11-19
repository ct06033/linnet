/**
 * W5a E2EE-UI: wizard + recovery reducers (pure), SecuritySheet flows against
 * a mocked adapter, banner statuses, RoomView wiring (banner click + UTD
 * help link) against the fake homeserver.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { SecuritySheet, SecurityBanner, type SecurityAdapter } from "./Security.js";
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

// ---------------------------------------------------------------- sheet UI

function mockAdapter(over: Partial<SecurityAdapter> = {}): SecurityAdapter & { calls: string[] } {
  const calls: string[] = [];
  let ready = false;
  const a: SecurityAdapter & { calls: string[] } = {
    calls,
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
    async status(): Promise<SecurityStatus> {
      return { cryptoAvailable: true, ready, backupEnabled: true, backupCount: 7 };
    },
    async runBackup() {
      calls.push("runBackup");
    },
    ...over,
  };
  return a;
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
});

describe("W5a banner", () => {
  it("maps status to labels", () => {
    const { unmount } = render(
      <SecurityBanner
        encrypted
        status={{ cryptoAvailable: true, ready: true, backupEnabled: true, backupCount: 1 }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByTestId("security-banner").textContent).toContain("Secured");
    unmount();
    render(
      <SecurityBanner
        encrypted
        status={{ cryptoAvailable: true, ready: false, backupEnabled: false, backupCount: null }}
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

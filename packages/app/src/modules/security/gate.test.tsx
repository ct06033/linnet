/**
 * W21 item 2: the mandatory security-gate flow tests. The gate is rendered
 * through a scripted SecurityAdapter (no rust crypto in jsdom); statuses
 * TRANSITION as flows succeed, exactly like the live HS would.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { SecurityGate } from "./gate.js";
import type { SecurityAdapter } from "./Security.js";
import type { SecurityStatus } from "./state.js";

const anyClient = { getUserId: () => "@alice:hs.test" } as unknown as MatrixClient;

interface Script {
  s: SecurityStatus;
  bootstrapArgs: { password: string; passphrase: string }[];
  unlockSecrets: ({ passphrase: string } | { recoveryKey: string })[];
}

function gate(script: Script): { adapter: SecurityAdapter; onSignOut: ReturnType<typeof vi.fn> } {
  const adapter = {
    async status() {
      return script.s;
    },
    async bootstrap(_o: { password: string; passphrase: string }) {
      script.bootstrapArgs.push({ password: _o.password, passphrase: _o.passphrase });
      script.s = { ...script.s, ready: true, ssssReady: true, crossSigningReady: true, backupEnabled: true };
      return "RecoveryKey ABCD 1234";
    },
    async unlock(o: { secret: { passphrase: string } | { recoveryKey: string } }) {
      script.unlockSecrets.push(o.secret);
      script.s = { ...script.s, ready: true, crossSigningReady: true };
      return 12;
    },
    restorePassphrase: async () => 0,
    restoreRecoveryKey: async () => 0,
    runBackup: async () => undefined,
    sessions: async () => [],
    beginDeviceVerification: async () => {
      throw new Error("unused");
    },
    revoke: async () => undefined,
    logoutAll: async () => undefined,
    onIncomingRequest: () => () => undefined,
  } as unknown as SecurityAdapter;
  return { adapter, onSignOut: vi.fn() };
}

const fresh = (over: Partial<SecurityStatus> = {}): SecurityStatus => ({
  cryptoAvailable: true,
  ready: false,
  ssssReady: false,
  crossSigningReady: false,
  backupEnabled: false,
  backupCount: null,
  ...over,
});

function mount(script: Script) {
  const { adapter, onSignOut } = gate(script);
  const tree = render(<SecurityGate client={anyClient} adapter={adapter} onSignOut={onSignOut} />);
  return { ...tree, onSignOut };
}

describe("W21 item 2 security gate", () => {
  it("renders NOTHING when already ready, or crypto unavailable", async () => {
    const a = mount({ s: fresh({ ready: true, ssssReady: true, crossSigningReady: true }), bootstrapArgs: [], unlockSecrets: [] });
    await waitFor(() => expect(a.container.firstChild).toBeNull());
    a.rerender(<SecurityGate client={null} adapter={{} as SecurityAdapter} onSignOut={() => undefined} />);
    expect(a.container.firstChild).toBeNull();
    const b = mount({ s: fresh({ cryptoAvailable: false }), bootstrapArgs: [], unlockSecrets: [] });
    await waitFor(() => expect(b.container.firstChild).toBeNull());
  });

  it("unprotected account -> mandatory passphrase SETUP; recovery key shown once; ack closes", async () => {
    const script: Script = { s: fresh(), bootstrapArgs: [], unlockSecrets: [] };
    const { container } = mount(script);
    await screen.findByTestId("security-gate");
    // mandatory: NO dismiss affordance anywhere, and Escape does nothing
    expect(screen.queryByLabelText(/close|dismiss/i)).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("security-gate")).toBeTruthy();

    // short passphrase rejected BEFORE any adapter call
    fireEvent.change(screen.getByLabelText(/account password/i), { target: { value: "hunter2" } });
    fireEvent.change(screen.getByLabelText(/min 8 characters/i), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText(/confirm passphrase/i), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /protect my messages/i }));
    await screen.findByText(/at least 8 characters/i);

    // mismatched confirm rejected
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByTestId("security-gate");
    fireEvent.change(screen.getByLabelText(/min 8 characters/i), { target: { value: "correct horse" } });
    fireEvent.change(screen.getByLabelText(/confirm passphrase/i), { target: { value: "correct horses" } });
    fireEvent.click(screen.getByRole("button", { name: /protect my messages/i }));
    await screen.findByText(/don't match/i);

    // accepted: setup runs, key shown once, ack finishes -> ready -> gate gone
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    const pass1 = await screen.findByLabelText(/min 8 characters/i);
    fireEvent.change(pass1, { target: { value: "correct horse" } });
    fireEvent.change(screen.getByLabelText(/confirm passphrase/i), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: /protect my messages/i }));
    await screen.findByText(/save your recovery key/i);
    expect(screen.getByDisplayValue("RecoveryKey ABCD 1234")).toBeTruthy();
    expect(script.bootstrapArgs).toEqual([{ password: "hunter2", passphrase: "correct horse" }]);
    fireEvent.click(screen.getByRole("button", { name: /i saved it/i }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("locked device on an SSSS account -> UNLOCK modal; recovery-key route accepted; success closes", async () => {
    const script: Script = {
      s: fresh({ ssssReady: true, backupEnabled: true, backupCount: 40 }),
      bootstrapArgs: [],
      unlockSecrets: [],
    };
    const { container } = mount(script);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.change(screen.getByLabelText(/^security passphrase$/i), { target: { value: "s3cret phrase" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(script.unlockSecrets).toEqual([{ passphrase: "s3cret phrase" }]);

    // route flip to recovery key
    const script2: Script = { s: fresh({ ssssReady: true }), bootstrapArgs: [], unlockSecrets: [] };
    mount(script2);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByRole("button", { name: /use a recovery key instead/i }));
    fireEvent.change(screen.getByLabelText(/recovery key/i), { target: { value: "AaBb 1234" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    await waitFor(() => expect(script2.unlockSecrets).toEqual([{ recoveryKey: "AaBb 1234" }]));
  });

  it("wrong unlock secret -> error step offers retry + sign out (the only escape hatch)", async () => {
    const script: Script = {
      s: fresh({ ssssReady: true }),
      bootstrapArgs: [],
      unlockSecrets: [],
    };
    const { adapter, onSignOut } = gate(script);
    adapter.unlock = () => Promise.reject(new Error("bad passphrase"));
    render(<SecurityGate client={anyClient} adapter={adapter} onSignOut={onSignOut} />);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.change(screen.getByLabelText(/^security passphrase$/i), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    await screen.findByText(/couldn.t continue/i);
    expect(screen.getByText(/bad passphrase/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("probe failure never traps the user (gate falls silent)", async () => {
    const { adapter, onSignOut } = gate({ s: fresh(), bootstrapArgs: [], unlockSecrets: [] });
    adapter.status = () => Promise.reject(new Error("sync down"));
    const { container } = render(<SecurityGate client={anyClient} adapter={adapter} onSignOut={onSignOut} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});

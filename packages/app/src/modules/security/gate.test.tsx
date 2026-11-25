/**
 * W21 item 2: the mandatory security-gate flow tests. The gate is rendered
 * through a scripted SecurityAdapter (no rust crypto in jsdom); statuses
 * TRANSITION as flows succeed, exactly like the live HS would.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { SecurityGate, mapSecretStorageError } from "./gate.js";
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

describe("W21-HOTFIX gate routing after Sean's prod report (11-24)", () => {
  const status = { cryptoAvailable: true, ready: false, ssssReady: false, crossSigningReady: false, backupEnabled: false, backupCount: 0 };
  it("a setup attempt on an account that already has keys auto-routes to the unlock screen with guidance", async () => {
    const adapter = {
      status: async () => status,
      bootstrap: async () => {
        throw new Error("This account already has encryption keys from another app, so a brand-new passphrase can't be created here. Cannot reset cross-signing keys");
      },
      unlock: async () => 0,
      restorePassphrase: async () => 0,
    } as unknown as SecurityAdapter;
    render(<SecurityGate client={anyClient} adapter={adapter} onSignOut={() => undefined} />);
    await screen.findByText("Set your security passphrase");
    const fields = document.querySelectorAll<HTMLButtonElement>(".gate-dialog input");
    fireEvent.change(fields[0], { target: { value: "acct-password" } });
    fireEvent.change(fields[1], { target: { value: "brand-new-pass" } });
    fireEvent.change(fields[2], { target: { value: "brand-new-pass" } });
    fireEvent.click(screen.getByText("Protect my messages"));
    await screen.findByText("Unlock your encrypted history");
    expect(screen.getByTestId("gate-hint").textContent).toMatch(/already has encryption keys/);
  });

  it("recovery-key route renders a visible (unmasked) input plus format guidance", async () => {
    const adapter = {
      status: async () => ({ ...status, ssssReady: true }),
      bootstrap: async () => "x",
      unlock: async () => 0,
      restorePassphrase: async () => 0,
    } as unknown as SecurityAdapter;
    render(<SecurityGate client={anyClient} adapter={adapter} onSignOut={() => undefined} />);
    await screen.findByText("Unlock your encrypted history");
    fireEvent.click(screen.getByText("Use a recovery key instead"));
    const inp = document.querySelector<HTMLInputElement>(".gate-dialog input");
    expect(inp?.type).toBe("text");
    expect(document.querySelector(".gate-dialog")?.textContent).toMatch(/Groups of 4 characters/);
  });
});

describe("W22 raw SDK crypto errors never surface (Sean prod: bad MAC verbatim in 0.2.4)", () => {
  it("mapSecretStorageError maps the decryption-failure family; everything else passes through verbatim", () => {
    expect(mapSecretStorageError("Error decrypting secret m.megolm_backup.v1: bad MAC")).toMatch(
      /doesn't match any copy of your secrets/,
    );
    expect(
      mapSecretStorageError("Could not decrypt m.cross_signing.master because none of the keys are for a supported algorithm"),
    ).toMatch(/Try the other option/);
    // honesty rule: wrong-password and our own actionable copy survive unwrapped
    expect(mapSecretStorageError("Invalid password")).toBe("Invalid password");
    expect(mapSecretStorageError("wrong passphrase or recovery key")).toBe("wrong passphrase or recovery key");
  });

  it("gate unlock error step shows the actionable copy instead of the raw bad-MAC string", async () => {
    const adapter = {
      status: async () => ({
        cryptoAvailable: true,
        ready: false,
        ssssReady: true,
        crossSigningReady: false,
        backupEnabled: true,
        backupCount: 5,
      }),
      bootstrap: async () => "x",
      unlock: async () => {
        throw new Error("Error decrypting secret m.megolm_backup.v1: bad MAC");
      },
      restorePassphrase: async () => 0,
    } as unknown as SecurityAdapter;
    render(<SecurityGate client={anyClient} adapter={adapter} onSignOut={() => undefined} />);
    await screen.findByText("Unlock your encrypted history");
    fireEvent.change(screen.getByLabelText(/^security passphrase$/i), { target: { value: "stale key attempt" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    await screen.findByText(/couldn.t continue/i);
    const dialog = document.querySelector(".gate-dialog");
    expect(dialog?.textContent).toMatch(/doesn't match any copy of your secrets/);
    expect(dialog?.textContent).not.toMatch(/bad MAC/);
  });
});

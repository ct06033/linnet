/**
 * W24 route E — RotateSecurityPanel gate tests: panel gating (disabled until
 * fields valid), the unmasked recovery-key field + passphrase↔key toggle,
 * the forced-ack one-time view of the NEW key with honest retired-credential
 * copy, edge-H copy, the mapSecretStorageError family vs VERBATIM server
 * strings (b28e991), no credential retention after failure, and the Security
 * center entry. The destructive reset (W23-B) stays exactly where it was.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { RotateSecurityPanel, SecurityGate } from "./gate.js";
import { SecuritySheet } from "./Security.js";
import type { SecurityAdapter } from "./Security.js";
import type { SecurityStatus } from "./state.js";

const anyClient = { getUserId: () => "@alice:hs.test" } as unknown as MatrixClient;

const fresh = (over: Partial<SecurityStatus> = {}): SecurityStatus => ({
  cryptoAvailable: true,
  ready: false,
  ssssReady: false,
  crossSigningReady: false,
  backupEnabled: false,
  backupCount: null,
  ...over,
});

interface RotateScript {
  s: SecurityStatus;
  rotateArgs: Array<{ secret: unknown; passphrase: string; userId: string }>;
  result?: { recoveryKey: string; imported: number; crossSigningImported: boolean; masterSecretWasStored: boolean };
  error?: (msg: string) => Error;
}

function mkScript(over: Partial<RotateScript> = {}): RotateScript {
  return {
    s: fresh({ ssssReady: true }),
    rotateArgs: [],
    ...over,
  };
}

const NEWKEY = "EoJp ABCD EFGH IJKL MNOP QRST UVWX YZ01 EoJp ABCD EFGH IJKL MNOP QRST";

function adapterFor(script: RotateScript): SecurityAdapter {
  const adapter: Partial<SecurityAdapter> = {
    async status() {
      return script.s;
    },
    async unlock() {
      return 6;
    },
    async rotateRecovery(o) {
      script.rotateArgs.push({ secret: o.secret, passphrase: o.passphrase, userId: o.userId });
      if (script.error) throw script.error("bad MAC — Error decrypting secret m.cross_signing.master: bad MAC");
      const r = script.result ?? {
        recoveryKey: NEWKEY,
        imported: 6,
        crossSigningImported: true,
        masterSecretWasStored: true,
      };
      if (r) script.s = { ...script.s, ready: true, ssssReady: true, crossSigningReady: true, backupEnabled: true };
      return r;
    },
    async resetSecurity() {
      return { recoveryKey: "x" };
    },
    async describeAccount() {
      throw new Error("not needed");
    },
    async bootstrap() {
      return "k";
    },
  };
  return adapter as unknown as SecurityAdapter;
}

async function mountRotate(script: RotateScript) {
  const onSignOut = vi.fn();
  render(<SecurityGate client={anyClient} adapter={adapterFor(script)} onSignOut={onSignOut} />);
  await screen.findByTestId("security-gate");
  fireEvent.click(screen.getByTestId("rotate-entry"));
  await screen.findByTestId("rotate-prove");
  return { onSignOut };
}

/** fill prove+passphrase and press go */
async function driveToGo(proof: string, pass: string): Promise<void> {
  fireEvent.change(screen.getByTestId("rotate-proof"), { target: { value: proof } });
  fireEvent.click(screen.getByTestId("rotate-prove-next"));
  await screen.findByTestId("rotate-passphrase");
  fireEvent.change(screen.getByTestId("rotate-pass1"), { target: { value: pass } });
  fireEvent.change(screen.getByTestId("rotate-pass2"), { target: { value: pass } });
  fireEvent.click(screen.getByTestId("rotate-go"));
}

describe("W24 rotate entry + prove step", () => {
  it("unlock screen offers the NON-destructive rotate entry (and keeps the destructive reset entry)", async () => {
    const script = mkScript();
    render(<SecurityGate client={anyClient} adapter={adapterFor(script)} onSignOut={vi.fn()} />);
    await screen.findByTestId("security-gate");
    expect(screen.getByTestId("reset-entry")).toBeTruthy();
    expect(screen.getByTestId("rotate-entry")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rotate-entry"));
    await screen.findByTestId("rotate-prove");
  });

  it("recovery-key field is UNMASKED with the E-group hint; Continue stays disabled until proof is non-empty", async () => {
    await mountRotate(mkScript());
    const input = screen.getByTestId("rotate-proof") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(screen.getByTestId("rotate-key-hint").textContent).toMatch(/Groups of 4 characters starting with E/);
    expect((screen.getByTestId("rotate-prove-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } }); // whitespace-only is not a proof
    expect((screen.getByTestId("rotate-prove-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "EoJp ABCD" } });
    expect((screen.getByTestId("rotate-prove-next") as HTMLButtonElement).disabled).toBe(false);
  });

  it("toggle switches passphrase↔key: masked input, labels follow, proof is cleared", async () => {
    await mountRotate(mkScript());
    fireEvent.change(screen.getByTestId("rotate-proof"), { target: { value: "EoJp ABCD" } });
    fireEvent.click(screen.getByTestId("rotate-proof-toggle"));
    await screen.findByTestId("rotate-prove");
    const input = screen.getByTestId("rotate-proof") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe(""); // never carry typed secrets across routes
    expect(screen.queryByTestId("rotate-key-hint")).toBeNull();
    expect(screen.getByText("Use my recovery key instead")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rotate-proof-toggle"));
    expect((screen.getByTestId("rotate-proof") as HTMLInputElement).type).toBe("text");
  });
});

describe("W24 new-passphrase step gating", () => {
  it("go is disabled until both fields agree and the passphrase is at least 8 chars", async () => {
    await mountRotate(mkScript());
    fireEvent.change(screen.getByTestId("rotate-proof"), { target: { value: "EoJp ABCD EFGH" } });
    fireEvent.click(screen.getByTestId("rotate-prove-next"));
    await screen.findByTestId("rotate-passphrase");
    fireEvent.change(screen.getByTestId("rotate-pass1"), { target: { value: "abcdefg" } }); // 7
    fireEvent.change(screen.getByTestId("rotate-pass2"), { target: { value: "abcdefg" } });
    expect((screen.getByTestId("rotate-go") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("rotate-pass1"), { target: { value: "abcdefgh" } });
    expect((screen.getByTestId("rotate-go") as HTMLButtonElement).disabled).toBe(true); // mismatch
    fireEvent.change(screen.getByTestId("rotate-pass2"), { target: { value: "abcdefgh" } });
    expect((screen.getByTestId("rotate-go") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("W24 full rotation → forced ack", () => {
  it("key-proof flow: working line → ONE-TIME view of the new key with retired-credential copy → ack closes the gate", async () => {
    const script = mkScript();
    await mountRotate(script);
    await driveToGo("EoJp ABCD EFGH IJKL", "new passphrase x");
    // progress line while awaiting the adapter
    await screen.findByTestId("rotate-working");
    await screen.findByTestId("rotate-showkey");
    expect((screen.getByTestId("rotate-newkey") as HTMLTextAreaElement).value).toBe(NEWKEY);
    const copy = screen.getByTestId("rotate-showkey").textContent ?? "";
    expect(copy).toMatch(/only time the new key is/i);
    expect(copy).toMatch(/no longer work/i); // old credential retired — plainly
    // core got the RIGHT shapes: recoveryKey proof, new passphrase, userId
    expect(script.rotateArgs.length).toBe(1);
    expect(script.rotateArgs[0]).toEqual({
      secret: { recoveryKey: "EoJp ABCD EFGH IJKL" },
      passphrase: "new passphrase x",
      userId: "@alice:hs.test",
    });
    // ack: key cleared from state + gate re-probes and closes
    fireEvent.click(screen.getByTestId("rotate-ack"));
    await waitFor(() => expect(screen.queryByTestId("security-gate")).toBeNull());
    expect((screen.queryByTestId("rotate-newkey") as HTMLTextAreaElement | null)?.value ?? "").toBe("");
  });

  it("passphrase-proof route sends {passphrase}, not {recoveryKey}", async () => {
    const script = mkScript();
    await mountRotate(script);
    fireEvent.click(screen.getByTestId("rotate-proof-toggle"));
    await driveToGo("old phrase here", "new passphrase x");
    await screen.findByTestId("rotate-showkey");
    expect(script.rotateArgs[0].secret).toEqual({ passphrase: "old phrase here" });
  });

  it("edge H (master never in 4S): key view adds the honest verify-elsewhere copy", async () => {
    const script = mkScript({
      result: { recoveryKey: NEWKEY, imported: 4, crossSigningImported: false, masterSecretWasStored: false },
    });
    await mountRotate(script);
    await driveToGo("EoJp ABCD EFGH IJKL", "new passphrase x");
    await screen.findByTestId("rotate-edgeh");
    const note = screen.getByTestId("rotate-edgeh").textContent ?? "";
    expect(note).toMatch(/never stored in your recovery setup/);
    expect(note.replace(/\s+/g, " ")).toMatch(/cross-verification|full Reset/);
    // no promise of old-key access anywhere (copy rule)
    expect((screen.getByTestId("rotate-showkey").textContent ?? "")).not.toMatch(/can still be recovered/i);
  });
});

describe("W24 error honesty (mapSecretStorageError family vs verbatim)", () => {
  async function driveToError(err: (msg: string) => Error) {
    const script = mkScript({ error: err });
    await mountRotate(script);
    await driveToGo("EoJp ABCD EFGH IJKL", "new passphrase x");
    await screen.findByTestId("rotate-error");
    return script;
  }

  it("decryption-family errors are reworded actionably — raw SDK strings NEVER surface", async () => {
    await driveToError((m) => new Error(m));
    const msg = screen.getByTestId("rotate-error-message").textContent ?? "";
    expect(msg).toMatch(/doesn.t match any copy/i);
    expect(msg).not.toMatch(/bad MAC|Error decrypting/i);
  });

  it("server-shaped strings propagate VERBATIM (no rotate-failure wrapper)", async () => {
    const script = mkScript();
    script.error = undefined;
    const adapter = adapterFor(script);
    adapter.rotateRecovery = () => Promise.reject(new Error("403: only the owner may do that (UIA)"));
    render(<RotateSecurityPanel client={anyClient} adapter={adapter} onDone={() => undefined} />);
    await screen.findByTestId("rotate-prove");
    await driveToGo("EoJp ABCD", "new passphrase x");
    await screen.findByTestId("rotate-error");
    expect(screen.getByTestId("rotate-error-message").textContent).toMatch(/only the owner may do that \(UIA\)/);
  });

  it("failed rotation clears the typed proof AND both passphrase fields (W23-A no-retention rule)", async () => {
    await driveToError((m) => new Error(m));
    fireEvent.click(screen.getByTestId("rotate-retry"));
    await screen.findByTestId("rotate-prove");
    expect((screen.getByTestId("rotate-proof") as HTMLInputElement).value).toBe("");
    // back into step 2: pass fields also cleared
    fireEvent.change(screen.getByTestId("rotate-proof"), { target: { value: "EoJp ABCD" } });
    fireEvent.click(screen.getByTestId("rotate-prove-next"));
    await screen.findByTestId("rotate-passphrase");
    expect((screen.getByTestId("rotate-pass1") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("rotate-pass2") as HTMLInputElement).value).toBe("");
  });
});

describe("W24 Security center entry", () => {
  it("Recovery settings → Rotate opens the same panel on an SSSS account (non-destructive path beside reset)", async () => {
    const script: RotateScript = { s: fresh({ ssssReady: true }), rotateArgs: [] };
    render(<SecuritySheet client={anyClient} adapter={adapterFor(script)} onClose={() => undefined} />);
    await screen.findByTestId("start-rotate");
    expect(screen.getByTestId("start-reset")).toBeTruthy(); // both options coexist
    fireEvent.click(screen.getByTestId("start-rotate"));
    await screen.findByTestId("rotate-prove");
    fireEvent.click(screen.getByTestId("rotate-cancel"));
    await waitFor(() => expect(screen.queryByTestId("rotate-prove")).toBeNull());
  });
});

/**
 * W23 locked-out UX — gate screen tests (routes A, B, D).
 *
 * A — "Try my account login password" affordance on the unlock screen:
 *     password-typed input, same core unlock path, no storage.
 * B — DESTRUCTIVE "reset your security access": honest impact screen first,
 *     "I understand" gating the form, forced-ack new key, and the wrong-
 *     password VERBATIM rule (b28e991) that no reset copy may wrap.
 * D — "What your account actually has": always-available disclosure,
 *     auto-open after two failures, the four rule headlines (mapped in
 *     core and rendered here), and the clipboard "Copy details" support
 *     text (full key ids — they are public account data — never
 *     ciphertext/iv/mac).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import type { SecurityAccountDescription } from "@linnet/core";
import { SecurityGate } from "./gate.js";
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

interface W23Script {
  s: SecurityStatus;
  unlockSecrets: ({ passphrase: string } | { recoveryKey: string })[];
  resetArgs: { password: string; passphrase: string }[];
  desc?: SecurityAccountDescription | null;
}

function mkScript(over: Partial<W23Script> = {}): W23Script {
  return { s: fresh({ ssssReady: true }), unlockSecrets: [], resetArgs: [], ...over };
}

function adapterFor(script: W23Script): SecurityAdapter {
  return {
    async status() {
      return script.s;
    },
    async unlock(o: { secret: { passphrase: string } | { recoveryKey: string } }) {
      script.unlockSecrets.push(o.secret);
      script.s = { ...script.s, ready: true, crossSigningReady: true };
      return 12;
    },
    async resetSecurity(o: { password: string; passphrase: string }) {
      script.resetArgs.push({ password: o.password, passphrase: o.passphrase });
      script.s = { ...script.s, ready: true, ssssReady: true, crossSigningReady: true, backupEnabled: true };
      return { recoveryKey: "NewE recovery key4321" };
    },
    async describeAccount() {
      return script.desc ?? descFixture();
    },
    async bootstrap() {
      return "unused";
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
}

function mount(script: W23Script, adapter?: SecurityAdapter) {
  const a = adapter ?? adapterFor(script);
  const tree = render(<SecurityGate client={anyClient} adapter={a} onSignOut={vi.fn()} />);
  return { ...tree, adapter: a };
}

function descFixture(over: Partial<SecurityAccountDescription> = {}): SecurityAccountDescription {
  const base: SecurityAccountDescription = {
    homeserver: "https://hs.test",
    userId: "@alice:hs.test",
    defaultKeyId: "Bcurrent",
    keys: [
      {
        keyId: "Bcurrent",
        isDefault: true,
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        name: "Element security key",
        passphraseDerived: true,
        pbkdf2Iterations: 500000,
        guardsSecrets: ["m.cross_signing.master", "m.megolm_backup.v1"],
      },
    ],
    secrets: [
      { name: "m.cross_signing.master", exists: true, keyIds: ["Bcurrent"] },
      { name: "m.cross_signing.self_signing", exists: true, keyIds: ["Bcurrent"] },
      { name: "m.cross_signing.user_signing", exists: true, keyIds: ["Bcurrent"] },
      { name: "m.megolm_backup.v1", exists: true, keyIds: ["Bcurrent"] },
    ],
    backup: { exists: true, version: "3", algorithm: "m.megolm.v1.aes-sha2", count: 7 },
    hasPassphraseDerivedKey: true,
    staleEntries: false,
    headline:
      "Your passphrase protects key Element security key. If it was made in Element, it is what Element asks for under Settings → Security & Privacy.",
    notes: [],
  };
  return { ...base, ...over } as SecurityAccountDescription;
}

// ---------------------------------------------------------------------------
// A

describe("W23-A try-my-login-password affordance on the unlock screen", () => {
  it("reveals a masked current-password field and unlocks through the SAME core passphrase path", async () => {
    const script = mkScript();
    const { container } = mount(script);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("try-login-password"));
    const inp = screen.getByTestId("unlock-loginpw-input") as HTMLInputElement;
    expect(inp.type).toBe("password");
    expect(inp.getAttribute("autocomplete")).toBe("current-password");
    expect(document.querySelector(".gate-dialog")?.textContent).toMatch(
      /reuse your login password as your security passphrase/,
    );
    fireEvent.change(inp, { target: { value: "my-login-pw" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    // same unlock() core path — the typed password IS the passphrase attempt
    await waitFor(() => expect(script.unlockSecrets).toEqual([{ passphrase: "my-login-pw" }]));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("login-password failures route through mapSecretStorageError and NEVER linger in the field", async () => {
    const script = mkScript();
    const adapter = adapterFor(script);
    adapter.unlock = () => Promise.reject(new Error("Error decrypting secret m.megolm_backup.v1: bad MAC"));
    mount(script, adapter);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("try-login-password"));
    fireEvent.change(screen.getByTestId("unlock-loginpw-input"), { target: { value: "guess-pw" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    await screen.findByText(/couldn.t continue/i);
    // mapped actionable copy, raw bad MAC hidden (W22 rule)
    const dialog = document.querySelector(".gate-dialog");
    expect(dialog?.textContent).toMatch(/doesn't match any copy of your secrets/);
    expect(dialog?.textContent).not.toMatch(/bad MAC/);
    // password never kept: the error + Try again cycle clears it (the route
    // stays on login-password, the field comes back EMPTY — never prefilled)
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByText(/unlock your encrypted history/i);
    expect((screen.getByTestId("unlock-loginpw-input") as HTMLInputElement).value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// B

describe("W23-B destructive reset behind an honest confirmation", () => {
  it("confirm bullets -> 'I understand' gates the form -> password+passphrase -> forced key ack -> gate closes", async () => {
    const script = mkScript();
    const { container } = mount(script);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("reset-entry"));

    await screen.findByTestId("reset-confirm");
    const impact = screen.getByTestId("reset-impact").textContent ?? "";
    expect(impact).toMatch(/will NOT be recoverable — its key was protected by the passphrase you lost/);
    expect(impact).toMatch(/New messages going forward will be backed up with the new key/);
    expect(impact).toMatch(/identity changed \/ session not verified/);
    expect(impact).toMatch(/Requires your account password/);
    const cont = screen.getByTestId("reset-continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("reset-understand"));
    expect(cont.disabled).toBe(false);
    fireEvent.click(cont);

    await screen.findByTestId("reset-form");
    const submit = screen.getByTestId("reset-go") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("reset-password"), { target: { value: "acct-pw" } });
    fireEvent.change(screen.getByTestId("reset-pass1"), { target: { value: "tiny" } });
    fireEvent.change(screen.getByTestId("reset-pass2"), { target: { value: "tiny" } });
    expect(submit.disabled).toBe(true); // min 8 enforced before calling core
    fireEvent.change(screen.getByTestId("reset-pass1"), { target: { value: "brand new phrase" } });
    fireEvent.change(screen.getByTestId("reset-pass2"), { target: { value: "brand new phrase" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await screen.findByTestId("reset-showkey"); // forced-ack one-time key view (W21 pattern)
    fireEvent.click(screen.getByTestId("reset-ack"));
    await waitFor(() => expect(container.firstChild).toBeNull()); // unlocked device -> gate gone
    expect(script.resetArgs).toEqual([{ password: "acct-pw", passphrase: "brand new phrase" }]);
  });

  it("wrong account password surfaces VERBATIM — no reset-copy wrapper eats the server message", async () => {
    const script = mkScript();
    const adapter = adapterFor(script);
    adapter.resetSecurity = () => Promise.reject(new Error("Invalid password"));
    mount(script, adapter);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("reset-entry"));
    await screen.findByTestId("reset-confirm");
    fireEvent.click(screen.getByTestId("reset-understand"));
    fireEvent.click(screen.getByTestId("reset-continue"));
    await screen.findByTestId("reset-form");
    fireEvent.change(screen.getByTestId("reset-password"), { target: { value: "nope" } });
    fireEvent.change(screen.getByTestId("reset-pass1"), { target: { value: "brand new phrase" } });
    fireEvent.change(screen.getByTestId("reset-pass2"), { target: { value: "brand new phrase" } });
    fireEvent.click(screen.getByTestId("reset-go"));
    await screen.findByTestId("reset-error");
    expect(screen.getByTestId("reset-error-message").textContent).toBe("Invalid password");
  });

  it("a decryption-family reset error maps to actionable copy (W22 rule preserved)", async () => {
    const script = mkScript();
    const adapter = adapterFor(script);
    adapter.resetSecurity = () =>
      Promise.reject(new Error("Error decrypting secret m.cross_signing.master: bad MAC"));
    mount(script, adapter);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("reset-entry"));
    fireEvent.click(await screen.findByTestId("reset-understand"));
    fireEvent.click(screen.getByTestId("reset-continue"));
    fireEvent.change(await screen.findByTestId("reset-password"), { target: { value: "pw" } });
    fireEvent.change(screen.getByTestId("reset-pass1"), { target: { value: "brand new phrase" } });
    fireEvent.change(screen.getByTestId("reset-pass2"), { target: { value: "brand new phrase" } });
    fireEvent.click(screen.getByTestId("reset-go"));
    await screen.findByTestId("reset-error");
    expect(screen.getByTestId("reset-error-message").textContent).toMatch(/doesn't match any copy of your secrets/);
  });

  it("the banned framing never appears: the flow itself is never presented as a 'recovery'", async () => {
    const script = mkScript();
    mount(script);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("reset-entry"));
    await screen.findByTestId("reset-confirm");
    const dialog = document.querySelector(".gate-dialog")!;
    // Titles / action words must be RESET framing, never recovery framing.
    // ("recovery key" as the noun for the base58 key is the legitimate term.)
    const headings = Array.from(dialog.querySelectorAll("h3, button")).map((el) => el.textContent ?? "");
    for (const h of headings) expect(h).not.toMatch(/\brecover\b|\brecovering\b|\bnew recovery\b/i);
    expect(headings.join(" ")).toMatch(/Reset your security access/i);
    // history loss is stated in the negative — the one allowed "recover*" use
    const impact = screen.getByTestId("reset-impact").textContent ?? "";
    expect(impact).toMatch(/NOT be recoverable/);
  });
});

// ---------------------------------------------------------------------------
// D

describe("W23-D account diagnostics on the unlock screen", () => {
  it("the Show details disclosure is always available and renders the actionable headline", async () => {
    const script = mkScript();
    mount(script);
    await screen.findByText(/unlock your encrypted history/i);
    const link = screen.getByTestId("show-diagnostics");
    expect(link.textContent).toMatch(/Show details/i);
    fireEvent.click(link);
    await screen.findByTestId("security-diagnostics");
    expect(screen.getByTestId("diag-headline").textContent).toMatch(
      /Your passphrase protects key Element security key/,
    );
    expect(screen.getByTestId("diag-keys").textContent).toMatch(/Bcurrent/);
    expect(screen.getByTestId("diag-keys").textContent).toMatch(/passphrase-derived \(PBKDF2, 500000 iterations\)/);
    expect(screen.getByTestId("diag-secrets").textContent).toMatch(/m.cross_signing.master: stored under Bcurrent/);
    expect(screen.getByTestId("diag-backup").textContent).toMatch(/version 3/);
  });

  it("renders all four W23-D rule headlines (rule1 / rule2 / rule3 / stale-note)", async () => {
    const cases: SecurityAccountDescription[] = [
      descFixture({
        hasPassphraseDerivedKey: false,
        keys: [
          { keyId: "Gk", isDefault: true, algorithm: "aes", name: null, passphraseDerived: false, pbkdf2Iterations: null, guardsSecrets: [] },
        ],
        headline: "This account has no security passphrase — only a recovery key. Use the recovery key, or reset.",
      }),
      descFixture(), // rule 2 (base fixture)
      descFixture({
        keys: [],
        defaultKeyId: null,
        secrets: [
          { name: "m.cross_signing.master", exists: false, keyIds: [] },
          { name: "m.cross_signing.self_signing", exists: false, keyIds: [] },
          { name: "m.cross_signing.user_signing", exists: false, keyIds: [] },
          { name: "m.megolm_backup.v1", exists: false, keyIds: [] },
        ],
        headline:
          "No cross-signing secret is stored — recovery from this account's 4S is impossible; resetting or another session are the paths.",
      }),
      descFixture({
        // the W22 multi-entry shape
        staleEntries: true,
        keys: [
          { keyId: "Bcurrent", isDefault: true, algorithm: "aes", name: "Element security key", passphraseDerived: true, pbkdf2Iterations: 500000, guardsSecrets: ["m.cross_signing.master"] },
          { keyId: "Aolder", isDefault: false, algorithm: "aes", name: null, passphraseDerived: false, pbkdf2Iterations: null, guardsSecrets: ["m.megolm_backup.v1"] },
        ],
        secrets: [
          { name: "m.cross_signing.master", exists: true, keyIds: ["Aolder", "Bcurrent"] },
          { name: "m.cross_signing.self_signing", exists: true, keyIds: ["Bcurrent"] },
          { name: "m.cross_signing.user_signing", exists: true, keyIds: ["Bcurrent"] },
          { name: "m.megolm_backup.v1", exists: true, keyIds: ["Aolder"] },
        ],
        notes: [
          "Some copies of your secrets are protected by an older key — recent Element changes rotated your keys; the current one should still work.",
        ],
      }),
    ];
    for (const desc of cases) {
      const { unmount } = mount(mkScript({ desc }));
      await screen.findByText(/unlock your encrypted history/i);
      fireEvent.click(screen.getByTestId("show-diagnostics"));
      await screen.findByTestId("security-diagnostics");
      expect(screen.getByTestId("diag-headline").textContent).toBe(desc.headline);
      if (desc.notes.length) expect(screen.getByTestId("diag-note").textContent).toBe(desc.notes[0]);
      if (desc.staleEntries) {
        // redaction rule: BOTH key ids appear in full (public account data)
        expect(screen.getByTestId("diag-keys").textContent).toContain("Aolder");
        expect(screen.getByTestId("diag-keys").textContent).toContain("Bcurrent");
      }
      unmount();
    }
  });

  it("auto-opens after TWO failed unlock attempts (no click needed)", async () => {
    const script = mkScript();
    const adapter = adapterFor(script);
    adapter.unlock = () => Promise.reject(new Error("wrong passphrase or recovery key"));
    mount(script, adapter);
    await screen.findByText(/unlock your encrypted history/i);
    // attempt 1
    fireEvent.change(screen.getByLabelText(/^security passphrase$/i), { target: { value: "one" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    await screen.findByText(/couldn.t continue/i);
    expect(screen.queryByTestId("security-diagnostics")).toBeNull();
    // attempt 2
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.change(screen.getByLabelText(/^security passphrase$/i), { target: { value: "two" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock my history/i }));
    await screen.findByText(/couldn.t continue/i);
    await screen.findByTestId("security-diagnostics"); // revealed automatically
  });

  it("Copy details writes the plain-text readout to the clipboard — full key ids, no secret material", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const script = mkScript({
      desc: descFixture({
        staleEntries: true,
        keys: [
          { keyId: "Bcurrent", isDefault: true, algorithm: "aes", name: "Element security key", passphraseDerived: true, pbkdf2Iterations: 500000, guardsSecrets: ["m.cross_signing.master"] },
          { keyId: "Aolder", isDefault: false, algorithm: "aes", name: null, passphraseDerived: false, pbkdf2Iterations: null, guardsSecrets: ["m.megolm_backup.v1"] },
        ],
      }),
    });
    mount(script);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("show-diagnostics"));
    await screen.findByTestId("security-diagnostics");
    fireEvent.click(screen.getByTestId("diag-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const pasted: string = (writeText.mock.calls as unknown as string[][])[0][0];
    expect(pasted).toContain("Bcurrent");
    expect(pasted).toContain("Aolder");
    expect(pasted).toContain("Key backup: version 3");
    expect(pasted).not.toMatch(/ciphertext/);
  });

  it("diagnostics read failure degrades honestly instead of trapping the user", async () => {
    const script = mkScript();
    const adapter = adapterFor(script);
    adapter.describeAccount = () => Promise.reject(new Error("sync down"));
    mount(script, adapter);
    await screen.findByText(/unlock your encrypted history/i);
    fireEvent.click(screen.getByTestId("show-diagnostics"));
    await screen.findByTestId("diag-failed");
    expect(screen.getByTestId("diag-failed").textContent).toMatch(/unavailable/i);
  });
});

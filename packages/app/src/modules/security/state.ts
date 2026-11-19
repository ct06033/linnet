/**
 * linnet.security state layer — pure reducers for the setup + recovery flows
 * and the account security probe. No React, no js-sdk hard dependency
 * (the probe duck-types the crypto backend so tests can mock it).
 */

// ---------------------------------------------------------------------------
// Setup wizard machine (PRD §8 ladder: cross-signing + SSSS + backup, one
// recovery key shown exactly once with forced acknowledgment).

export type WizardStep =
  | { step: "intro" }
  | { step: "credentials"; password: string }
  | { step: "keymode"; password: string }
  | { step: "working"; password: string; passphrase: string }
  | { step: "showKey"; recoveryKey: string }
  | { step: "done" }
  | { step: "error"; message: string; back: WizardStep };

export type WizardEvent =
  | { t: "begin" }
  | { t: "password"; value: string }
  | { t: "credsNext" }
  | { t: "choose"; mode: "passphrase" | "auto"; passphrase: string }
  | { t: "success"; recoveryKey: string }
  | { t: "fail"; message: string }
  | { t: "retry" }
  | { t: "ack" }
  | { t: "reset" };

export const wizardInitial: WizardStep = { step: "intro" };

export function wizardReduce(state: WizardStep, ev: WizardEvent): WizardStep {
  switch (ev.t) {
    case "begin":
      return state.step === "intro" ? { step: "credentials", password: "" } : state;
    case "password":
      return state.step === "credentials" ? { step: "credentials", password: ev.value } : state;
    case "credsNext":
      return state.step === "credentials" && state.password ? { step: "keymode", password: state.password } : state;
    case "choose": {
      if (state.step !== "keymode") return state;
      if (ev.mode === "passphrase" && ev.passphrase.length < 8) return state; // gate: min 8 (core enforces too)
      return { step: "working", password: state.password, passphrase: ev.passphrase };
    }
    case "success":
      return state.step === "working" ? { step: "showKey", recoveryKey: ev.recoveryKey } : state;
    case "fail":
      return { step: "error", message: ev.message, back: state };
    case "retry":
      return state.step === "error" && state.back.step === "working" ? state.back : state;
    case "ack":
      return state.step === "showKey" ? { step: "done" } : state;
    case "reset":
      return wizardInitial;
  }
}

// ---------------------------------------------------------------------------
// Recovery flow machine (existing-device secret restores server key backup).

export type RestoreStep =
  | { step: "route" }
  | { step: "input"; route: "passphrase" | "key"; value: string }
  | { step: "working"; route: "passphrase" | "key"; value: string }
  | { step: "progress"; route: "passphrase" | "key"; value: string; total?: number; imported?: number }
  | { step: "done"; imported: number }
  | { step: "error"; message: string; back: RestoreStep };

export type RestoreEvent =
  | { t: "pick"; route: "passphrase" | "key" }
  | { t: "value"; value: string }
  | { t: "submit" }
  | { t: "progress"; total?: number; imported?: number }
  | { t: "done"; imported: number }
  | { t: "fail"; message: string }
  | { t: "retry" }
  | { t: "again" };

export const restoreInitial: RestoreStep = { step: "route" };

export function restoreReduce(state: RestoreStep, ev: RestoreEvent): RestoreStep {
  switch (ev.t) {
    case "pick":
      return state.step === "route" ? { step: "input", route: ev.route, value: "" } : state;
    case "value":
      return state.step === "input" ? { ...state, value: ev.value } : state;
    case "submit":
      return state.step === "input" && state.value.length > 0
        ? { step: "working", route: state.route, value: state.value }
        : state;
    case "progress":
      return state.step === "working" || state.step === "progress"
        ? { step: "progress", route: (state as { route: "passphrase" | "key" }).route, value: (state as { value: string }).value, total: ev.total, imported: ev.imported }
        : state;
    case "done":
      return state.step === "working" || state.step === "progress" ? { step: "done", imported: ev.imported } : state;
    case "fail":
      return { step: "error", message: ev.message, back: state };
    case "retry":
      return state.step === "error" && state.back.step === "working"
        ? { step: "working", route: state.back.route, value: state.back.value }
        : state;
    case "again":
      return restoreInitial;
  }
}

// ---------------------------------------------------------------------------
// Account status probe (duck-typed so jsdom tests never touch rust crypto).

export interface SecurityStatus {
  cryptoAvailable: boolean;
  ready: boolean | null; // cross-signing + 4S + backup all on
  backupEnabled: boolean;
  backupCount: number | null;
}

interface CryptoLike {
  isCrossSigningReady(): Promise<boolean>;
  isSecretStorageReady(): Promise<boolean>;
  getKeyBackupInfo(): Promise<unknown>;
  checkKeyBackupAndEnable?(): Promise<unknown>;
}

export interface ProbeClient {
  getCrypto?(): CryptoLike | null;
  getHomeserverUrl(): string;
  getUserId?(): string | null;
  fetchToken?(): string; // tests + app adapter set this; prod fills from client
}

export async function probeStatus(
  client: ProbeClient,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SecurityStatus> {
  const crypto = client.getCrypto?.() ?? null;
  if (!crypto) {
    return { cryptoAvailable: false, ready: null, backupEnabled: false, backupCount: null };
  }
  let ready: boolean | null = null;
  let backupEnabled = false;
  try {
    const [xsign, ssss, info] = await Promise.all([
      crypto.isCrossSigningReady(),
      crypto.isSecretStorageReady(),
      crypto.getKeyBackupInfo(),
    ]);
    backupEnabled = Boolean(info);
    ready = Boolean(xsign && ssss && info);
  } catch {
    ready = null;
  }
  let backupCount: number | null = null;
  try {
    const res = await fetchImpl(`${client.getHomeserverUrl()}/_matrix/client/v3/room_keys/version`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { total?: number };
      backupCount = typeof body.total === "number" ? body.total : null;
    }
  } catch {
    backupCount = null;
  }
  return { cryptoAvailable: true, ready, backupEnabled, backupCount };
}

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** random strong passphrase for the "generate a key for me" mode */
export function autoPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join("");
 }

/**
 * W18 — renderer side of the update flow. The Electron MAIN process owns the
 * state machine (apps/desktop/src/updater.ts); this hook mirrors it via the
 * preload bridge. On the web build (no bridge) it reports null and the update
 * UI hides itself entirely.
 *
 * Ordering rule: every snapshot carries a monotonic `seq` from main; pushes
 * (events) and pull results (get/resync) both flow through ONE guarded
 * applier, so a slow in-flight get can never clobber a fresher event.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UpdateSnapshot } from "@linnet/core";

const DISMISS_KEY = "linnet.up…dled";

/** Version dismissed via "Later". ONE module-level value with subscribers —
 *  banner and menu row share it, so "Check now" re-arms the banner. */
let dismissedVer: string | null = null;
const dismissSubs = new Set<() => void>();

function notifyDismissed(): void {
  for (const f of dismissSubs) f();
}

/** Version the user dismissed ("Later"); persists across sessions. */
export function loadDismissed(): string {
  if (dismissedVer === null) {
    try {
      dismissedVer = globalThis.localStorage?.getItem(DISMISS_KEY) ?? "";
    } catch {
      dismissedVer = "";
    }
  }
  return dismissedVer;
}

export function saveDismissed(version: string): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, version);
  } catch {
    /* storage off: dismissal just won't persist */
  }
  dismissedVer = version;
  notifyDismissed();
}

/** Clear the dismissal (next banner of any version shows again). */
export function clearDismissed(): void {
  try {
    globalThis.localStorage?.removeItem(DISMISS_KEY);
  } catch {
    /* ignore */
  }
  dismissedVer = "";
  notifyDismissed();
}

function useDismissed(): string {
  return useSyncExternalStore(
    (cb) => {
      dismissSubs.add(cb);
      return () => {
        dismissSubs.delete(cb);
      };
    },
    loadDismissed,
    loadDismissed,
  );
}

export interface UpdatesView extends UpdateSnapshot {
  dismissed: string;
  /** re-read the snapshot from main (event loss safety net) */
  refresh(): Promise<void>;
  /** clears the persisted dismissal + runs a check (menu "Check now") */
  checkNow(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  dismiss(version: string): void;
  setEnabled(on: boolean): Promise<void>;
}

export function useUpdates(): UpdatesView | null {
  const [snap, setSnap] = useState<UpdateSnapshot | null>(null);
  const dismissed = useDismissed();
  const seqRef = useRef(-1);

  const apply = useCallback((s: UpdateSnapshot) => {
    if (s.seq <= seqRef.current) return; // stale — event/pull race guard
    seqRef.current = s.seq;
    setSnap(s);
  }, []);

  const bridge = window.linnet?.updates;
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const off = bridge.onEvent((s) => {
      if (live) apply(s);
    });
    // pull AFTER subscribing so no transition can slip between the two
    void bridge
      .get()
      .then((s) => live && apply(s))
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, [bridge, apply]);

  if (!bridge || !snap) return null;

  const resync = (): Promise<void> =>
    bridge
      .get()
      .then(apply)
      .catch(() => undefined);

  return {
    ...snap,
    dismissed,
    async refresh() {
      await resync();
    },
    async checkNow() {
      clearDismissed();
      await bridge.check();
      await resync(); // the broadcast usually lands first; this is the safety net
    },
    async download() {
      await bridge.download();
      await resync();
    },
    async install() {
      await bridge.install();
    },
    dismiss(version: string) {
      saveDismissed(version);
    },
    async setEnabled(on: boolean) {
      const next = await bridge.setEnabled(on);
      apply(next);
    },
  };
}

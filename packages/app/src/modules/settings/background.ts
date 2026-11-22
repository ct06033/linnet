/**
 * W19 3a — renderer mirror of the desktop tray state: session pause (tray
 * menu, source of truth is the main process) and the autostart toggle.
 * Returns null wherever there is no tray bridge (web build, tray-less
 * desktop where IPC was never registered) so the UI hides itself.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface BackgroundView {
  /** notifications currently paused via the tray menu */
  paused: boolean;
  /** null = homeserver/platform doesn't answer (no checkbox until known) */
  autostart: boolean | null;
  setAutostart(on: boolean): Promise<void>;
}

export function useBackground(): BackgroundView | null {
  const tray = window.linnet?.tray;
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    if (!tray) return;
    let live = true;
    const off = tray.onPause((p) => {
      if (!live) return;
      pausedRef.current = p;
      setPaused(p);
    });
    // Both IPCs must exist for the tray surface to be real; a missing
    // handler rejects (electron "No handler registered") -> stay hidden.
    Promise.all([tray.pauseGet(), tray.autostartGet()])
      .then(([p, a]) => {
        if (!live) return;
        pausedRef.current = p;
        setPaused(p);
        setAutostartState(a);
        setReady(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, [tray]);

  const setAutostart = useCallback(
    async (on: boolean) => {
      if (!tray) return;
      setAutostartState(await tray.autostartSet(on));
    },
    [tray],
  );

  if (!tray || !ready) return null;
  return { paused, autostart, setAutostart };
}


/**
 * W19 3a — pure tray/background-notify policy (no electron imports: this is
 * the tested half; tray.ts/main.ts are thin glue). PRD §6.6 "OS-native
 * notifications + tray"; design round decision D2 (close→tray ON, autostart
 * opt-in, pause session-only).
 */

export const DESKTOP_FILE_NAME = "linnet.desktop";

export type CloseAction = "hide-to-tray" | "quit";

/** Window 'close' decision: hide to tray unless we're really quitting. */
export function onCloseWindow(opts: { quitting: boolean; trayActive: boolean }): CloseAction {
  return opts.quitting || !opts.trayActive ? "quit" : "hide-to-tray";
}

/** True when launched with the --hidden flag (autostart with tray only). */
export function startsHidden(argv: readonly string[]): boolean {
  return argv.includes("--hidden");
}

/**
 * Where the Linux autostart entry lives; null on win32 (uses
 * app.setLoginItemSettings) and other platforms.
 */
export function autostartFilePath(platform: string, homeDir: string): string | null {
  if (platform !== "linux") return null;
  return `${homeDir}/.config/autostart/${DESKTOP_FILE_NAME}`;
}

/**
 * .desktop content for the Linux autostart entry. X-Deep-... no; plain keys
 * only. Exec points at the running AppImage/executable with --hidden so the
 * login session lands in the tray, not a window.
 */
export function autostartDesktopFile(execPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Linnet",
    "Comment=Matrix chat (background notifier)",
    "Exec=" + execPath + " --hidden",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Tray context-menu labels (pause state is session-only, PRD D2). */
export function trayMenuLabels(paused: boolean): { toggle: string; quit: string; open: string } {
  return {
    open: "Open Linnet",
    toggle: paused ? "Resume notifications" : "Pause notifications",
    quit: "Quit Linnet",
  };
}

/** KV key holding the autostart preference (source of truth on win32;
 *  on linux the FILE existence is truth — this mirrors the intent). */
export const KV_AUTOSTART = "linnet.tray.autostart";

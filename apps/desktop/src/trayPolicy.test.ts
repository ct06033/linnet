import { describe, expect, it } from "vitest";
import {
  autostartDesktopFile,
  autostartFilePath,
  onCloseWindow,
  startsHidden,
  trayMenuLabels,
} from "./trayPolicy.js";

describe("onCloseWindow", () => {
  it("hides to tray while the tray lives and we are not quitting", () => {
    expect(onCloseWindow({ quitting: false, trayActive: true })).toBe("hide-to-tray");
  });
  it("quits on real quit or when the tray failed to initialize", () => {
    expect(onCloseWindow({ quitting: true, trayActive: true })).toBe("quit");
    expect(onCloseWindow({ quitting: false, trayActive: false })).toBe("quit");
    expect(onCloseWindow({ quitting: true, trayActive: false })).toBe("quit");
  });
});

describe("startsHidden", () => {
  it("detects the --hidden login flag", () => {
    expect(startsHidden(["/usr/bin/linnet", "--hidden"])).toBe(true);
    expect(startsHidden(["/usr/bin/linnet"])).toBe(false);
    expect(startsHidden(["--hiddenish"])).toBe(false);
  });
});

describe("autostartFilePath", () => {
  it("linux writes into the XDG autostart dir", () => {
    expect(autostartFilePath("linux", "/home/ai")).toBe("/home/ai/.config/autostart/linnet.desktop");
  });
  it("win32/other platforms have no file (Login Items API)", () => {
    expect(autostartFilePath("win32", "C:\\Users\\ai")).toBeNull();
    expect(autostartFilePath("darwin", "/Users/ai")).toBeNull();
  });
});

describe("autostartDesktopFile", () => {
  it("carries --hidden so login starts tray-only", () => {
    const txt = autostartDesktopFile("/opt/Linnet.AppImage");
    expect(txt).toContain("Exec=/opt/Linnet.AppImage --hidden");
    expect(txt.startsWith("[Desktop Entry]")).toBe(true);
    expect(txt).toContain("X-GNOME-Autostart-enabled=true");
  });
});

describe("trayMenuLabels", () => {
  it("toggle label mirrors current pause state", () => {
    expect(trayMenuLabels(false).toggle).toBe("Pause notifications");
    expect(trayMenuLabels(true).toggle).toBe("Resume notifications");
    expect(trayMenuLabels(false).quit).toBe("Quit Linnet");
  });
});

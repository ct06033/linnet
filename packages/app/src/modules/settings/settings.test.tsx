/**
 * W5b — room settings via the RoomView gear: rename/topic through real
 * PUT state + own echo, PL gating, members, leave/forget, avatar upload.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeHomeserverControls,
  type FakeRoom,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

const ROOMS: FakeRoom[] = [
  { roomId: "!dev:hs.test", name: "dev", topic: "old topic", members: { "@bob:hs.test": "invite" } },
  {
    roomId: "!low:hs.test",
    name: "low",
    powerLevels: { users: { "@other:hs.test": 100 }, users_default: 0, state_default: 50 },
  },
];

let controls!: FakeHomeserverControls;

function freshManager(): SessionManager {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: () => makeSyncSnapshot({ userId: ALICE.userId, rooms: ROOMS }),
  });
  controls = fetchFn.controls;
  // uploadBytes (media/core) uses global fetch — stub it to the fake HS
  vi.stubGlobal("fetch", fetchFn);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn });
}

async function openSettings(roomName: string): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  fireEvent.click(await screen.findByText(roomName, { selector: ".roomlist .name" }));
  fireEvent.click(await screen.findByRole("button", { name: "Room settings" }));
  await screen.findByText("Room settings", { selector: ".settings-head strong" });
}

describe("W5b room settings", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => {
    setSessionManagerForTests(freshManager());
    vi.unstubAllGlobals();
  });

  it("R1: save name PUTs m.room.name and the header + row update from the echo", async () => {
    render(<App />);
    await openSettings("dev");
    fireEvent.change(screen.getByLabelText("Room name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(
        controls.calls.find(
          (c) => c.method === "PUT" && decodeURIComponent(c.path).includes("/state/m.room.name") &&
            (c.body as Record<string, unknown>)["name"] === "Renamed",
        ),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(document.querySelector(".room-name")?.textContent).toBe("Renamed"));
    await waitFor(() => expect(document.querySelector(".roomlist")?.textContent).toContain("Renamed"));
  });

  it("R2: save topic PUTs m.room.topic and the subheader updates", async () => {
    render(<App />);
    await openSettings("dev");
    fireEvent.change(screen.getByLabelText("Room topic"), { target: { value: "new topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Save topic" }));
    await waitFor(() => expect(document.querySelector(".sub .topic")?.textContent).toBe("new topic"));
  });

  it("R4/R7: PL-gated inputs and buttons are disabled for a PL-0 user", async () => {
    render(<App />);
    await openSettings("low");
    expect((screen.getByLabelText("Room name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Room topic") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Save name" }).hasAttribute("disabled")).toBe(true);
  });

  it("R5: members list shows joined (you) and pending invites", async () => {
    render(<App />);
    await openSettings("dev");
    const sec = document.querySelector("[aria-label='Members']");
    expect(sec?.textContent).toContain("@alice:hs.test (you)");
    expect(sec?.textContent).toContain("@bob:hs.test");
    expect(sec?.textContent).toMatch(/Invited \(1\)/);
  });

  it("R6: leave drops the room; forget checkbox adds POST /forget", async () => {
    render(<App />);
    await openSettings("dev");
    fireEvent.click(screen.getByLabelText("Also forget this room"));
    fireEvent.click(screen.getByRole("button", { name: "Leave room" }));
    await waitFor(() =>
      expect(controls.calls.some((c) => decodeURIComponent(c.path).endsWith("/rooms/!dev:hs.test/forget"))).toBe(true),
    );
    // the row is gone from the list (own leave echo drops membership)
    await waitFor(() => expect(document.querySelector(".roomlist")?.textContent).not.toMatch(/\bdev\b/));
  });

  it("R8: avatar upload PUTs m.room.avatar with the media URL", async () => {
    render(<App />);
    await openSettings("dev");
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    // jsdom File lacks arrayBuffer(); Tauri webviews have it — stub the instance
    (file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () =>
      new Uint8Array([1, 2, 3]).buffer;
    const input = screen.getByLabelText("Room avatar file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(
        controls.calls.find(
          (c) =>
            c.method === "PUT" &&
            decodeURIComponent(c.path).includes("/state/m.room.avatar") &&
            String((c.body as Record<string, unknown>)["url"] ?? "").startsWith("mxc://"),
        ),
      ).toBeTruthy(),
    );
  });
});

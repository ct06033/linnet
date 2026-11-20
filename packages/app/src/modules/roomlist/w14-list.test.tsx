/**
 * W14 list wave — Sean's items 2,3,4,5,6,7,11,13 at the app level:
 * favourites (standard m.favourite tag, top of EVERY view), collapsible
 * sections, member counts, ghosted topics, DMs of group members inside the
 * group view, avatar images in rows, the bottom "+ Room", the Home button.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const MEL = "@mel:hs.test";

const ROOMS: FakeRoom[] = [
  { roomId: "!sp1:hs.test", name: "Work", space: true, members: { [MEL]: "join" }, children: { "!team:hs.test": {} } },
  { roomId: "!team:hs.test", name: "team", topic: "ship the release", members: { [MEL]: "join", "@carol:hs.test": "join" } },
  { roomId: "!plain:hs.test", name: "plain", avatar: "mxc://hs.test/avatar123" },
  { roomId: "!dm:hs.test", name: "Mel", members: { [MEL]: "join" } },
];

let controls!: FakeHomeserverControls;

function freshManager(): SessionManager {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: () => makeSyncSnapshot({ userId: ALICE.userId, rooms: ROOMS, direct: ["!dm:hs.test"] }),
  });
  controls = fetchFn.controls;
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn });
}

async function signIn(): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  await screen.findByText("team", { selector: ".roomlist .name" });
}

describe("W14 room list", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    setSessionManagerForTests(freshManager());
  });
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("item 4+13: rows carry a member count and a ghosted topic", async () => {
    render(<App />);
    await signIn();
    const teamRow = screen.getByText("team", { selector: ".roomlist .name" }).closest("button")!;
    expect(teamRow.querySelector(".member-count")?.textContent).toContain("3");
    expect(teamRow.querySelector(".row-topic")?.textContent).toBe("ship the release");
    // rooms without topic show none
    const plainRow = screen.getByText("plain", { selector: ".roomlist .name" }).closest("button")!;
    expect(plainRow.querySelector(".row-topic")).toBeNull();
  });

  it("item 11: rows render the avatar image when the room/partner has one", async () => {
    render(<App />);
    await signIn();
    const plainRow = screen.getByText("plain", { selector: ".roomlist .name" }).closest("button")!;
    const img = plainRow.querySelector("img.avatar-img") as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img!.src).toContain("avatar123");
    // no avatar → initials tile, not an <img>
    const teamRow = screen.getByText("team", { selector: ".roomlist .name" }).closest("button")!;
    expect(teamRow.querySelector("img.avatar-img")).toBeNull();
    expect(teamRow.querySelector("span.avatar")?.textContent).toBe("T");
  });

  it("item 6: starring writes the standard m.favourite tag and moves the room into Favourites on every view", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Favourite plain" }));
    await waitFor(() =>
      expect(
        controls.calls.find((c) => c.method === "PUT" && decodeURIComponent(c.path).includes("/tags/m.favourite")),
      ).toBeTruthy(),
    );
    const heading = await waitFor(() => {
      const el = document.querySelector('.roomlist h3[data-section="fav"]');
      if (!el) throw new Error("no Favourites heading yet");
      return el;
    });
    expect(heading.textContent).toContain("Favourites");
    // rows in BOTH sections (a favourite AND a room) show the lit star
    await waitFor(() => expect(document.querySelectorAll(".fav-star.on").length).toBe(2));
    // and favourites show on the group view too (item 6: EVERY view)
    fireEvent.click(screen.getByRole("button", { name: "Space Work" }));
    await waitFor(() => expect(document.querySelector('.roomlist h3[data-section="fav"]')).toBeTruthy());
    // unfavourite via the same row star
    fireEvent.click(screen.getByRole("button", { name: "Unfavourite plain" }));
    await waitFor(() =>
      expect(controls.calls.some((c) => c.method === "DELETE" && decodeURIComponent(c.path).includes("/tags/m.favourite"))).toBeTruthy(),
    );
    await waitFor(() => expect(document.querySelector(".fav-star.on")).toBeNull());
  });

  it("item 7: section headers collapse and expand, and remember across views", async () => {
    render(<App />);
    await signIn();
    const peopleBtn = screen.getByRole("button", { name: /People/ });
    fireEvent.click(peopleBtn);
    expect(peopleBtn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Mel", { selector: ".roomlist .name" })).toBeNull();
    // persisted for the device
    expect(localStorage.getItem("linnet.sections.collapsed")).toContain("people");
    // Rooms section too — hides plain/team rows but not favourites
    fireEvent.click(screen.getByRole("button", { name: /Rooms/ }));
    expect(screen.queryByText("team", { selector: ".roomlist .name" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /People/ }));
    await screen.findByText("Mel", { selector: ".roomlist .name" });
  });

  it("item 5: the group view lists DMs with people who share the space, in its own section", async () => {
    render(<App />);
    await signIn();
    // Mel is NOT in Home's space section but the DM exists
    fireEvent.click(screen.getByRole("button", { name: "Space Work" }));
    await screen.findByText("team", { selector: ".roomlist .name" });
    const peopleSection = await screen.findByRole("button", { name: /People/ });
    expect(peopleSection).toBeTruthy();
    await screen.findByText("Mel", { selector: ".roomlist .name" });
    // ...while plain (no shared membership) stays out of the group view
    expect(document.querySelector(".roomlist")?.textContent).not.toContain("plain");
  });

  it("item 3: the rail Home button is a bordered button-styled block with aria-current", async () => {
    render(<App />);
    await signIn();
    const home = screen.getByRole("button", { name: "Home" });
    expect(home.className).toContain("home");
    expect(home.getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Space Work" }));
    expect(home.getAttribute("aria-current")).toBeNull();
  });
});

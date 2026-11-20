/**
 * P1 moderation: report content (POST /report) + ignore user
 * (m.ignored_user_list account data) with collapsed rows, reveal, and the
 * room-settings ignore toggles.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeEventLike,
  type FakeHomeserverControls,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

const EVENTS: FakeEventLike[] = [
  { type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "spam spam spam" }, event_id: "$m1", origin_server_ts: 1000 },
  { type: "m.room.message", sender: ALICE.userId, content: { msgtype: "m.text", body: "my own line" }, event_id: "$m2", origin_server_ts: 2000 },
];

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function mk(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [{ roomId: "!dev:hs.test", name: "linnet-dev", members: { [BOB]: "join", [ALICE.userId]: "join" }, events: EVENTS }],
      }),
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function signInAndOpenDev(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const rows = await screen.findAllByText("linnet-dev");
  fireEvent.click(rows.find((el) => el.closest(".roomlist"))!);
  await screen.findByText("spam spam spam");
}

describe("P1 moderation", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(mk());
  });
  afterEach(() => setSessionManagerForTests(mk()));

  it("own messages have no report button; others' do", async () => {
    await signInAndOpenDev();
    const bobRow = document.querySelector('[data-evid="$m1"]')!;
    const myRow = document.querySelector('[data-evid="$m2"]')!;
    expect(within(bobRow as HTMLElement).queryByLabelText("Report message")).toBeTruthy();
    expect(within(myRow as HTMLElement).queryByLabelText("Report message")).toBeNull();
  });

  it("report dialog submits POST /report and confirms", async () => {
    await signInAndOpenDev();
    const bobRow = document.querySelector('[data-evid="$m1"]')!;
    fireEvent.click(within(bobRow as HTMLElement).getByLabelText("Report message"));
    const dlg = await screen.findByTestId("report-dialog");
    fireEvent.change(within(dlg).getByLabelText("Report reason"), { target: { value: "advertising" } });
    fireEvent.click(within(dlg).getByTestId("report-submit"));
    await screen.findByTestId("report-done");
    await waitFor(() =>
      expect(
        fake.controls.calls.some(
          (c) => c.method === "POST" && /\/report\//.test(c.path) && JSON.stringify(c.body).includes("advertising"),
        ),
      ).toBe(true),
    );
  });

  it("ignore from the dialog collapses the row; reveal shows it again", async () => {
    await signInAndOpenDev();
    const bobRow = document.querySelector('[data-evid="$m1"]')!;
    fireEvent.click(within(bobRow as HTMLElement).getByLabelText("Report message"));
    const dlg = await screen.findByTestId("report-dialog");
    fireEvent.click(within(dlg).getByTestId("report-ignore"));
    const line = await screen.findByTestId("ignored-$m1");
    expect(line.textContent).toContain("Ignored message from bob");
    fireEvent.click(within(line).getByText("Show"));
    await waitFor(() => expect(screen.queryByTestId("ignored-$m1")).toBeNull());
    expect(screen.getByText("spam spam spam")).toBeTruthy();
  });

  it("room-settings ignore toggle hides rows; unignore restores", async () => {
    await signInAndOpenDev();
    fireEvent.click(screen.getByLabelText("Room settings"));
    const list = await screen.findByLabelText("Members");
    const bobLi = [...list.querySelectorAll("li")].find((li) => li.textContent?.includes(BOB))!;
    fireEvent.click(within(bobLi as HTMLElement).getByLabelText(`Ignore ${BOB}`));
    await screen.findByTestId("ignored-$m1");
    const list2 = screen.getByLabelText("Members");
    const bobLi2 = [...list2.querySelectorAll("li")].find((li) => li.textContent?.includes(BOB))!;
    fireEvent.click(within(bobLi2 as HTMLElement).getByLabelText(`Unignore ${BOB}`));
    await waitFor(() => expect(screen.queryByTestId("ignored-$m1")).toBeNull());
  });
});

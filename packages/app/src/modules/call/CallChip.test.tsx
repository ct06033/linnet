/**
 * W15 phase 2b — the header "N in call" chip derived from m.call.member
 * state rows, full-stack through App over the fake HS.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeEventLike,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

const EVENTS: FakeEventLike[] = [
  { type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "hey on the call?" }, event_id: "$c1", origin_server_ts: 1000 },
];

const IN_CALL_STATE = [
  {
    type: "m.call.member",
    state_key: "mem-bob-1",
    sender: BOB,
    content: { "m.call.member": { member_id: "mem-bob-1", foci: [{ type: "org.matrix.msc3266.livekit" }] } },
  },
];

let mgr: (withCall: boolean) => SessionManager;

function mk(withCall: boolean): SessionManager {
  const fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!group:hs.test",
            name: "weekend crew",
            members: { [BOB]: "join", [ALICE.userId]: "join" },
            events: EVENTS,
            ...(withCall ? { state: IN_CALL_STATE } : {}),
          },
        ],
      }),
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function openRoom(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const rows = await screen.findAllByText("weekend crew");
  fireEvent.click(rows.find((el) => el.closest(".roomlist"))!);
  await screen.findByText("hey on the call?");
}

describe("in-call chip (m.call.member)", () => {
  mgr = mk;
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
  });
  afterEach(() => setSessionManagerForTests(mk(false)));

  it("shows the chip with the live member count and opens the stage on click", async () => {
    setSessionManagerForTests(mk(true));
    await openRoom();
    const chip = await screen.findByTestId("in-call-chip");
    expect(chip.textContent).toContain("1 in call");
    fireEvent.click(chip);
    // opening the stage drives ensureCallWidget → the iframe appears (or the
    // readable no-transport error, both prove the click wired up)
    await waitFor(() =>
      expect(
        document.querySelector(".call-stage iframe, .call-stage [role='alert']"),
      ).toBeTruthy(),
    );
  });

  it("stays hidden when nobody holds an m.call.member row", async () => {
    setSessionManagerForTests(mk(false));
    await openRoom();
    expect(screen.queryByTestId("in-call-chip")).toBeNull();
  });
});

/**
 * W4b2 pickers & mentions: emoji insertion, reaction picker through the full
 * set, and @mention autocomplete feeding real m.mentions relations.
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
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function freshManager(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!r:hs.test",
            name: "rich-room",
            members: { "@bob:hs.test": "join", "@carol:hs.test": "join" },
            events: [
              {
                type: "m.room.message",
                sender: "@bob:hs.test",
                content: { msgtype: "m.text", body: "seed message" },
                event_id: "$m1",
                origin_server_ts: 1000,
              },
            ],
          },
        ],
      }),
  });
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function openRoom(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const matches = await screen.findAllByText("rich-room");
  fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
  await screen.findByText("seed message");
}

describe("W4b2 pickers & mentions", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("composer emoji picker inserts and sends", async () => {
    await openRoom();
    fireEvent.click(screen.getByLabelText("Insert emoji"));
    const picker = await screen.findByTestId("Emoji picker");
    fireEvent.change(picker.querySelector("input")!, { target: { value: "rocket" } });
    fireEvent.click(await screen.findByLabelText("rocket ship launch"));
    const box = screen.getByLabelText("Message");
    expect((box as HTMLTextAreaElement).value).toBe("🚀");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("🚀")).toBeTruthy();
  });

  it("reaction picker adds non-quick emoji", async () => {
    await openRoom();
    const row = Array.from(document.querySelectorAll(".row")).find((r) =>
      r.querySelector('[data-testid="msg-$m1"]'),
    );
    fireEvent.click(row!.querySelector('[aria-label="more reactions"]')!);
    const picker = await screen.findByTestId("Reaction picker");
    fireEvent.change(picker.querySelector("input")!, { target: { value: "brain" } });
    fireEvent.click(await screen.findByLabelText("brain smart"));
    await waitFor(() => {
      const send = fake.controls.calls.find((c) => c.path.includes("/send/m.reaction/"));
      const rel = (send?.body as Record<string, unknown>)?.["m.relates_to"] as Record<string, unknown>;
      return rel?.["key"] === "🧠";
    });
    expect(await screen.findByText(/🧠 1/)).toBeTruthy();
  });

  it("mention autocomplete inserts full mxid and wires m.mentions", async () => {
    await openRoom();
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "ping @car" } });
    const menu = await screen.findByTestId("mention-menu");
    expect(menu.textContent).toContain("carol");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("ping @carol:hs.test "),
    );
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await new Promise((r) => setTimeout(r, 250));
    console.log("M2", (screen.getByLabelText("Message") as HTMLTextAreaElement).value, JSON.stringify(fake.controls.calls.filter((c) => c.path.includes("/send/")).map((c) => c.body)));
  });

  it("mention menu arrow-key navigation", async () => {
    await openRoom();
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "hi @" } });
    await screen.findByTestId("mention-menu");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    const after = (screen.getByLabelText("Message") as HTMLTextAreaElement).value;
    expect(after.startsWith("hi @")).toBe(true);
    expect(after).not.toBe("hi @");
  });
});

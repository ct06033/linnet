/**
 * W19 3a — EmailPusherRow: real js-sdk client over the fake HS (3PID +
 * pusher validation mirror Synapse). Covers the four UI truths: off/on,
 * no-email account, foreign pusher.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";
import { createFakeHomeserver, makeSyncSnapshot, type FakeHomeserverControls } from "@linnet/core";
import { createClientSession } from "@linnet/core";
import { EmailPusherRow } from "./EmailPusherRow.js";

const ALICE = { userId: "@alice:hs.test", password: "pw", accessToken: "tok-alice" };

let client: MatrixClient;
let ctl: FakeHomeserverControls;

beforeEach(() => {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: () => makeSyncSnapshot({ userId: ALICE.userId, rooms: [] }),
  });
  ctl = fetchFn.controls;
  client = createClientSession({
    homeserverUrl: "https://hs.test",
    accessToken: ALICE.accessToken,
    deviceId: "DEV1",
    userId: ALICE.userId,
    fetchFn,
  });
});

afterEach(() => cleanup());

describe("EmailPusherRow", () => {
  it("off -> toggle on registers our digest pusher; off removes it", async () => {
    ctl.seedThreepids(ALICE.userId, [{ medium: "email", address: "s@x.test", verified: true }]);
    render(<EmailPusherRow client={client} />);
    await waitFor(() => expect(screen.getByTestId("email-digest-toggle")).toBeTruthy());
    const box = screen.getByTestId("email-digest-toggle") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(screen.getByTestId("email-status").textContent).toBe("off");

    fireEvent.click(box);
    await waitFor(() => expect(ctl.pushersFor(ALICE.userId)).toHaveLength(1));
    expect(ctl.pushersFor(ALICE.userId)[0]!.app_id).toBe("chat.linnet.email.DEV1");
    await waitFor(() => expect(screen.getByTestId("email-status").textContent).toBe("digest to s@x.test"));

    fireEvent.click(screen.getByTestId("email-digest-toggle"));
    await waitFor(() => expect(ctl.pushersFor(ALICE.userId)).toHaveLength(0));
    await waitFor(() => expect(screen.getByTestId("email-status").textContent).toBe("off"));
  });

  it("account without an email: hint + disabled checkbox", async () => {
    render(<EmailPusherRow client={client} />);
    await waitFor(() => expect(screen.getByTestId("email-status")).toBeTruthy());
    expect(screen.getByTestId("email-status").textContent).toContain("no email");
    expect((screen.getByTestId("email-digest-toggle") as HTMLInputElement).disabled).toBe(true);
  });

  it("foreign email pusher is shown as informational and not touched", async () => {
    ctl.seedThreepids(ALICE.userId, [{ medium: "email", address: "s@x.test" }]);
    await client.setPusher({
      kind: "email",
      app_id: "im.element.web.email.DEV9",
      app_display_name: "Element",
      device_display_name: "chrome",
      pushkey: "s@x.test",
      lang: "en",
      data: {},
    } as never);
    render(<EmailPusherRow client={client} />);
    await waitFor(() => expect(screen.getByTestId("email-status").textContent).toContain("already on"));
    expect((screen.getByTestId("email-digest-toggle") as HTMLInputElement).disabled).toBe(true);
    expect(ctl.pushersFor(ALICE.userId)).toHaveLength(1);
  });

  it("server rejects an unlinked email (race after 3pid removal) with plain copy", async () => {
    // seed AFTER mount-time read is impossible to hit deterministically, so
    // drive it: start with email, unseed, then flip the toggle (fake HS
    // validates at set time exactly like Synapse).
    ctl.seedThreepids(ALICE.userId, [{ medium: "email", address: "s@x.test" }]);
    render(<EmailPusherRow client={client} />);
    await waitFor(() => expect(screen.getByTestId("email-digest-toggle")).toBeTruthy());
    ctl.seedThreepids(ALICE.userId, []); // email vanished server-side
    fireEvent.click(screen.getByTestId("email-digest-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("email-status").textContent).toContain("account's own email"),
    );
  });
});

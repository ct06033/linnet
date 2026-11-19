// W8 login screen: SSO discovery UI, redirect handoff, loginToken bounce-back.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
} from "@linnet/core";
import { Login } from "./Login.js";
import { setSessionManagerForTests } from "../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

function ssoManager(): SessionManager {
  return new SessionManager({
    kv: new MemoryKv(),
    secrets: new MemorySecrets(),
    fetchFn: createFakeHomeserver({
      accounts: [ALICE],
      sso: [{ id: "okta", name: "Okta" }],
      sync: (userId) => makeSyncSnapshot({ userId, rooms: [] }),
    }),
  });
}

describe("Login W8 SSO", () => {
  beforeEach(() => setSessionManagerForTests(ssoManager()));

  it("L1 shows IdP buttons once flows are discovered", async () => {
    render(<Login defaultHomeserver="https://hs.test" onSignedIn={() => {}} />);
    expect(await screen.findByRole("button", { name: /continue with okta/i })).toBeTruthy();
    // password form stays available alongside SSO
    expect(screen.getByLabelText(/username/i)).toBeTruthy();
  });

  it("L2 clicking the IdP navigates to the HS-provided bounce URL", async () => {
    const navigate = vi.fn();
    render(<Login defaultHomeserver="https://hs.test" onSignedIn={() => {}} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: /continue with okta/i }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    const url = navigate.mock.calls[0][0] as string;
    expect(url).toContain("loginToken=ssotok-");
  });

  it("L3 loginToken in the return query completes sign-in", async () => {
    const sm = ssoManager();
    setSessionManagerForTests(sm);
    const bounced = await sm.getSsoLoginUrl("https://hs.test", "https://app.test/");
    const onSignedIn = vi.fn();
    const onTokenConsumed = vi.fn();
    const qs = new URL(bounced).search; // "?loginToken=ssotok-N"
    render(
      <Login
        defaultHomeserver="https://hs.test"
        onSignedIn={onSignedIn}
        search={qs}
        onTokenConsumed={onTokenConsumed}
      />,
    );
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(onTokenConsumed).toHaveBeenCalled();
    expect(sm.activeId).toBe(`${ALICE.userId}|FAKEDEV`);
  });

  it("L4 a dead token surfaces an error instead of hanging", async () => {
    const onSignedIn = vi.fn();
    render(
      <Login
        defaultHomeserver="https://hs.test"
        onSignedIn={onSignedIn}
        search="?loginToken=expired"
        onTokenConsumed={() => {}}
      />,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("L5 every input has an accessible label (a11y)", async () => {
    render(<Login defaultHomeserver="https://hs.test" onSignedIn={() => {}} />);
    for (const name of [/homeserver/i, /username/i, /password/i]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });
});

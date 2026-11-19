import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("wave-1 shell", () => {
  it("renders the three panes with mock data", async () => {
    render(<App />);
    expect(screen.getByText("Linnet")).toBeTruthy();
    expect(screen.getByText("People")).toBeTruthy();
    expect(screen.getByText("not wired yet — wave 1 scaffold (mock shell)")).toBeTruthy();
    expect(screen.getAllByText("linnet-dev").length).toBeGreaterThan(0);
  });

  it("Ctrl+K opens the palette and lists module-registry commands", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByText(/registry: up/).length).toBeGreaterThan(0));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByText("/echo")).toBeTruthy();
  });
});

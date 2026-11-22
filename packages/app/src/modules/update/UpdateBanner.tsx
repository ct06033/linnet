/**
 * W18 — global update banner. Sits under the sync banner / above content;
 * appears only when the main process reports available/downloading/ready.
 * "Later" dismisses the exact version (persisted); a newer release or a
 * manual "Check now" re-arms it. Web builds never see it (no bridge).
 */
import type { ReactNode } from "react";
import type { UpdateSnapshot } from "@linnet/core";
import { useUpdates, type UpdatesView } from "./useUpdates.js";

/** One-line status for the account-menu Updates row. */
export function updateStatusText(u: UpdateSnapshot): string {
  switch (u.state.kind) {
    case "checking":
      return "checking…";
    case "up-to-date":
      return `v${u.current} (latest)`;
    case "available":
      return `v${u.state.version} available`;
    case "downloading":
      return `downloading v${u.state.version} — ${u.state.percent}%`;
    case "ready":
      return `v${u.state.version} ready to install`;
    case "error":
      return u.state.message;
    default:
      return `v${u.current}`;
  }
}

function openRelease(url: string): void {
  if (!url) return;
  if (window.linnet?.openExternal) window.linnet.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function UpdateBannerBody({ u }: { u: UpdatesView }): ReactNode {
  const { state } = u;
  if (state.kind === "available") {
    return (
      <>
        <span className="update-msg">Linnet v{state.version} is available (you have v{state.current}).</span>
        <div className="update-actions">
          {u.capability === "install-in-app" && (
            <button className="primary" data-testid="update-download" onClick={() => void u.download()}>
              Download update
            </button>
          )}
          <button data-testid="update-release-link" onClick={() => openRelease(state.url)}>
            View release
          </button>
          <button className="ghost" data-testid="update-later" onClick={() => u.dismiss(state.version)}>
            Later
          </button>
        </div>
      </>
    );
  }
  if (state.kind === "downloading") {
    return (
      <>
        <span className="update-msg">
          Downloading Linnet v{state.version} — {state.percent}%
        </span>
        <div className="update-actions">
          <span data-testid="update-progress" className="update-percent">
            {state.percent}%
          </span>
        </div>
      </>
    );
  }
  if (state.kind === "ready") {
    return (
      <>
        <span className="update-msg">Linnet v{state.version} is downloaded — restart to apply.</span>
        <div className="update-actions">
          <button className="primary" data-testid="update-restart" onClick={() => void u.install()}>
            Restart &amp; update
          </button>
          <button className="ghost" data-testid="update-later" onClick={() => u.dismiss(state.version)}>
            Later
          </button>
        </div>
      </>
    );
  }
  return null;
}

export function UpdateBanner(): ReactNode {
  const u = useUpdates();
  if (!u) return null;
  const { state } = u;
  if (state.kind !== "available" && state.kind !== "downloading" && state.kind !== "ready") return null;
  const version = state.version;
  if (u.dismissed === version) return null;
  return (
    <div className="update-banner" role="status" data-testid="update-banner" aria-label="Software update">
      <UpdateBannerBody u={u} />
    </div>
  );
}

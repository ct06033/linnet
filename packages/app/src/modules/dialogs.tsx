/**
 * W12 item 12 — shared dialog surfaces for the unified rail "+" control.
 * The create-space dialog moved here from SpaceRail unchanged in markup and
 * behavior; the create-room and join dialogs mirror it 1:1 so adding a group
 * vs a room feels like one consistent family. Escape/focus-trap come from
 * useModalA11y; scrim clicks dismiss (click-away for real modals).
 */
import { useRef, useState, type ReactNode } from "react";
import { useModalA11y } from "./a11y.js";

export function DialogOverlay({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useModalA11y(ref, onClose, true);
  return (
    <div
      className="dialog-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label} ref={ref} data-position="center">
        {children}
      </div>
    </div>
  );
}

interface NameDialogProps {
  onClose: () => void;
  onSubmit: (name: string, isPublic: boolean, encrypt: boolean) => Promise<void>;
}

/** One shape for both create dialogs — same fields, buttons and busy/error
 *  handling, only the labels differ (consistency is the whole point of item 12).
 *  W12 item 7 (carried through the merge from w12-core): the Encrypt (E2EE)
 *  toggle ships CHECKED — opting out is the user action; Public forces it off. */
function NameVisibilityDialog(props: {
  dialogLabel: string;
  heading: string;
  nameLabel: string;
  publicLabel: string;
  encryptLabel: string;
  submitLabel: string;
  busyLabel: string;
  onClose: () => void;
  onSubmit: (name: string, isPublic: boolean, encrypt: boolean) => Promise<void>;
}): ReactNode {
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [encrypt, setEncrypt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(name.trim(), isPublic, encrypt && !isPublic);
      props.onClose();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogOverlay label={props.dialogLabel} onClose={props.onClose}>
      <strong>{props.heading}</strong>
      {error && <p role="alert">{error}</p>}
      <label>
        Name
        <input
          autoFocus
          aria-label={props.nameLabel}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </label>
      <label className="check">
        <input type="checkbox" aria-label={props.publicLabel} checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        Public
      </label>
      <label className="check">
        <input
          type="checkbox"
          aria-label={props.encryptLabel}
          checked={encrypt && !isPublic}
          disabled={isPublic}
          onChange={(e) => setEncrypt(e.target.checked)}
        />
        Encrypt (E2EE)
        {isPublic && <span className="hint"> — public rooms cannot be encrypted</span>}
      </label>
      <div className="dialog-actions">
        <button onClick={props.onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!name.trim() || busy}>
          {busy ? props.busyLabel : props.submitLabel}
        </button>
      </div>
    </DialogOverlay>
  );
}

export function NewSpaceDialog({ onClose, onSubmit }: NameDialogProps): ReactNode {
  return (
    <NameVisibilityDialog
      dialogLabel="Create a new space"
      heading="New space"
      nameLabel="Space name"
      publicLabel="Public space"
      encryptLabel="Encrypt space (E2EE)"
      submitLabel="Create space"
      busyLabel="Creating…"
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

export function NewRoomDialog({ onClose, onSubmit }: NameDialogProps): ReactNode {
  return (
    <NameVisibilityDialog
      dialogLabel="Create a new room"
      heading="New room"
      nameLabel="Room name"
      publicLabel="Public room"
      encryptLabel="Encrypt room (E2EE)"
      submitLabel="Create room"
      busyLabel="Creating…"
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

export function JoinRoomDialog({
  onClose,
  onJoin,
}: {
  onClose: () => void;
  onJoin: (address: string) => Promise<void>;
}): ReactNode {
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!addr.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onJoin(addr.trim());
      onClose();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogOverlay label="Discover or join room" onClose={onClose}>
      <strong>Discover or join a room</strong>
      {error && <p role="alert">{error}</p>}
      <label>
        Address
        <input
          autoFocus
          aria-label="Room address or alias"
          placeholder="#room:hs.test or !roomId:hs.test"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </label>
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!addr.trim() || busy}>
          {busy ? "Joining…" : "Join room"}
        </button>
      </div>
    </DialogOverlay>
  );
}

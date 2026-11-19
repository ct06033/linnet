/**
 * Send lifecycle: optimistic states, retry, cancel, undo-send grace window.
 * Pure so the timing semantics are testable without React.
 */
export type SendStatus = "sending" | "sent" | "failed" | "canceled";

export interface SendRecord {
  status: SendStatus;
  eventKey: string; // pending lookup key until server ack
  startedAt: number;
  sentAt?: number;
  error?: string;
}

export interface UndoWindow {
  allowed: boolean;
  msLeft: number;
}

/** Undo-send only within `graceMs` after the server ack. */
export function undoWindow(record: SendRecord | undefined, now: number, graceMs: number): UndoWindow {
  if (!record || record.status !== "sent" || record.sentAt === undefined) {
    return { allowed: false, msLeft: 0 };
  }
  const msLeft = record.sentAt + graceMs - now;
  return { allowed: msLeft > 0, msLeft: Math.max(0, msLeft) };
}

export class SendLedger {
  private records = new Map<string, SendRecord>();

  start(eventKey: string, now: number): void {
    this.records.set(eventKey, { status: "sending", eventKey, startedAt: now });
  }
  ack(eventKey: string, now: number): void {
    const r = this.records.get(eventKey);
    if (r) this.records.set(eventKey, { ...r, status: "sent", sentAt: now });
  }
  fail(eventKey: string, error: string): void {
    const r = this.records.get(eventKey);
    if (r) this.records.set(eventKey, { ...r, status: "failed", error });
  }
  cancel(eventKey: string): void {
    this.records.delete(eventKey);
  }
  drop(eventKey: string): void {
    this.records.delete(eventKey);
  }
  get(eventKey: string): SendRecord | undefined {
    return this.records.get(eventKey);
  }
  byEventId(eventId: string, now: number): SendRecord | undefined {
    // server event ids replace the pending key on ack; caller keys both
    return this.records.get(eventId);
  }
  list(): SendRecord[] {
    return [...this.records.values()];
  }
}

/** Retry semantics: resend re-enters sending with a fresh key. */
export function nextRetry(old: SendRecord, now: number): SendRecord {
  return { status: "sending", eventKey: old.eventKey, startedAt: now };
}

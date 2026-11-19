/**
 * W7 — minimal fake WebRTC stack for jsdom tests: enough surface for
 * js-sdk 45 MatrixCall (transceivers, SDP, ICE-gathering-complete via a null
 * candidate on setLocalDescription). SDP strings are structurally realistic
 * because call.js parses/munges them.
 */
import type { vi } from "vitest";

export const FAKE_SDP_OFFER =
  "v=0\r\no=- 100 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
  "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtcp-mux\r\n" +
  "a=ice-ufrag:ufragA\r\na=ice-pwd:pwdpwdpwdA\r\n" +
  "a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11\r\n" +
  "a=setup:actpass\r\na=mid:0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n" +
  "a=sendrecv\r\na=msid:fakestream faketack\r\na=rtcp:9 IN IP4 0.0.0.0\r\n" +
  "a=rtpmap:111 opus/48000/2\r\na=rtcp-fb:111 transport-cc\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n";

export const FAKE_SDP_ANSWER = FAKE_SDP_OFFER.replace("a=setup:actpass", "a=setup:active").replace(
  "a=sendrecv",
  "a=sendrecv",
);

class FakeTrack {
  kind: string;
  id = "fake" + Math.random().toString(16).slice(2);
  enabled = true;
  muted = false;
  label = "fake";
  readyState = "live";
  constructor(kind: string) {
    this.kind = kind;
  }
  stop(): void {
    this.readyState = "ended";
  }
  clone(): FakeTrack {
    return new FakeTrack(this.kind);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  getCapabilities(): Record<string, unknown> {
    return {};
  }
  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }
  getSettings(): Record<string, unknown> {
    return { deviceId: "fake", groupId: "fake", echoCancellation: true };
  }
}

class FakeStream {
  id: string;
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack("audio")], id?: string) {
    this.tracks = tracks;
    this.id = id ?? "stream" + Math.random().toString(16).slice(2);
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return [];
  }
  addTrack(t: FakeTrack): void {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack): void {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeRTCSessionDescription {
  type: string;
  sdp: string;
  constructor(init: { type?: string; sdp?: string } = {}) {
    this.type = init.type ?? "offer";
    this.sdp = init.sdp ?? FAKE_SDP_OFFER;
  }
  toJSON(): { type: string; sdp: string } {
    return { type: this.type, sdp: this.sdp };
  }
}

class FakeRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  constructor(init: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } = {}) {
    this.candidate = init.candidate ?? "";
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
  toJSON(): { candidate: string } {
    return { candidate: this.candidate };
  }
}

type Handler = ((ev?: unknown) => void) | null;

class FakeRTCPeerConnection extends EventTarget {
  static generateCertificate(): Promise<unknown> {
    return Promise.resolve({});
  }
  localDescription: FakeRTCSessionDescription | null = null;
  remoteDescription: FakeRTCSessionDescription | null = null;
  signalingState = "stable";
  iceGatheringState = "new";
  iceConnectionState = "new";
  connectionState = "new";
  onicecandidate: Handler = null;
  ontrack: Handler = null;
  onnegotiationneeded: Handler = null;
  oniceconnectionstatechange: Handler = null;
  onconnectionstatechange: Handler = null;
  onicegatheringstatechange: Handler = null;
  onsignalingstatechange: Handler = null;
  private transceivers: unknown[] = [];
  private fireNegotiationNeeded(): void {
    queueMicrotask(() => {
      // js-sdk's gotUserMediaForInvite WAITS for this event to createOffer
      this.dispatchEvent(new Event("negotiationneeded"));
      this.onnegotiationneeded?.({});
    });
  }
  addTransceiver(trackOrKind: string | FakeTrack): {
    sender: { track: FakeTrack; replaceTrack(t: FakeTrack): void };
    receiver: { track: FakeTrack };
    direction: string;
    setCodecPreferences(): void;
  } {
    const track = typeof trackOrKind === "string" ? new FakeTrack(trackOrKind) : trackOrKind;
    const tr = {
      sender: { track, replaceTrack(): void {} },
      receiver: { track },
      direction: "sendrecv",
      setCodecPreferences(): void {},
    };
    this.transceivers.push(tr);
    this.fireNegotiationNeeded();
    return tr;
  }
  private lastStreamId = "fakestream";
  addTrack(track: FakeTrack, stream?: { id?: string }): { track: FakeTrack; replaceTrack(t: FakeTrack): void; getParameters(): { codecs?: unknown } } {
    if (stream?.id) this.lastStreamId = stream.id;
    this.fireNegotiationNeeded();
    return { track, replaceTrack(): void {}, getParameters: () => ({}) };
  }
  getTransceivers(): unknown[] {
    return this.transceivers;
  }
  getSenders(): unknown[] {
    return this.transceivers.map((t) => (t as { sender: unknown }).sender);
  }
  getReceivers(): unknown[] {
    return this.transceivers.map((t) => (t as { receiver: unknown }).receiver);
  }
  async setLocalDescription(desc?: { type?: string; sdp?: string } | null): Promise<void> {
    if (desc) this.localDescription = new FakeRTCSessionDescription(desc);
    this.iceGatheringState = "complete";
    queueMicrotask(() => {
      // js-sdk listens via addEventListener (EventTarget), not onX props
      this.dispatchEvent(new Event("icegatheringstatechange"));
      this.onicegatheringstatechange?.({});
      // null candidate == end of ICE gathering (what js-sdk waits for)
      this.onicecandidate?.({ candidate: null });
      this.dispatchEvent(
        Object.assign(new Event("icecandidate"), { candidate: null }),
      );
    });
  }
  async setRemoteDescription(desc: { type?: string; sdp?: string }): Promise<void> {
    this.remoteDescription = new FakeRTCSessionDescription(desc);
    this.signalingState = desc.type === "offer" ? "have-remote-offer" : "stable";
    // per spec, track events fire BEFORE the promise resolves (js-sdk checks
    // immediately after await)
    const msid = /a=msid:(\S+)\s/.exec(this.remoteDescription?.sdp ?? "")?.[1] ?? "fakestream";
    const trEvent = Object.assign(new Event("track"), {
      streams: [new FakeStream([new FakeTrack("audio")], msid)],
      track: new FakeTrack("audio"),
      receiver: { track: new FakeTrack("audio") },
    });
    this.dispatchEvent(trEvent);
    this.ontrack?.(trEvent);
  }
  async createOffer(): Promise<FakeRTCSessionDescription> {
    // msid MUST be our local stream id: the remote side looks up
    // SDPStreamMetadata by it (pushRemoteFeed)
    return new FakeRTCSessionDescription({
      type: "offer",
      sdp: FAKE_SDP_OFFER.replace("a=msid:fakestream faketack", `a=msid:${this.lastStreamId} faketack`),
    });
  }
  async createAnswer(): Promise<FakeRTCSessionDescription> {
    return new FakeRTCSessionDescription({ type: "answer", sdp: FAKE_SDP_ANSWER });
  }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
  close(): void {
    this.signalingState = "closed";
  }
}

/** Install stubs; call from tests BEFORE client.startClient(). */
class FakeAudioContext extends EventTarget {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 256,
      connect(): void {},
      disconnect(): void {},
      getByteFrequencyData(a: { fill?: (v: number) => void }): void {
        a?.fill?.(0);
      },
    };
  }
  createMediaStreamSource() {
    return { connect(): void {}, disconnect(): void {} };
  }
  createGain() {
    return {
      gain: { value: 1, setValueAtTime(): void {}, linearRampToValueAtTime(): void {} },
      connect(): void {},
      disconnect(): void {},
    };
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

export function installFakeWebRTC(viObj: typeof vi): void {
  viObj.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  viObj.stubGlobal("RTCSessionDescription", FakeRTCSessionDescription);
  viObj.stubGlobal("RTCIceCandidate", FakeRTCIceCandidate);
  viObj.stubGlobal("MediaStream", FakeStream);
  viObj.stubGlobal("AudioContext", FakeAudioContext);
  const audioCodec = {
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    parameters: { minptime: 10, useinbandfec: 1 },
    rtcpFeedback: [{ type: "transport-cc" }, { type: "nack" }],
  };
  const caps = () => ({ codecs: [audioCodec], headerExtensions: [] });
  viObj.stubGlobal("RTCRtpSender", { getCapabilities: caps });
  viObj.stubGlobal("RTCRtpReceiver", { getCapabilities: caps });
  (globalThis as { window: unknown }).window = globalThis as never;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (c?: { audio?: boolean; video?: boolean }) =>
        new FakeStream([
          ...(c?.audio ? [new FakeTrack("audio")] : []),
          ...(c?.video ? [new FakeTrack("video")] : []),
        ]),
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "fake-in", label: "Fake Mic", groupId: "g1" },
        { kind: "audiooutput", deviceId: "fake-out", label: "Fake Speaker", groupId: "g2" },
      ],
      addEventListener(): void {},
      removeEventListener(): void {},
    },
  });
}

export { FakeRTCPeerConnection, FakeStream, FakeTrack };

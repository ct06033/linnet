# W4b1 — THREADS (MSC3440)

- [x] threadSupport wired (startClient + createClient via spread — js-sdk types the opt ONLY on IStartClientOpts but reads it from constructor clientOpts; both ends set)
- [x] N-replies badge on thread roots (count + participants line); replies leave main stream (js-sdk partitions + our isThreadReply filter)
- [x] ThreadPanel docked right pane: root + replies via registry renderers, per-thread draft, Esc/backdrop close, room-switch reset
- [x] Panel composer + main-composer replies to rooted msgs use sendEvent(roomId, threadId, …) overload (hand-built m.thread relations get rewritten by js-sdk; is_falling_back is js-sdk-owned)
- [x] fake HS: /relations with one-shot pagination terminator, /event/{id} fetch (thread sends resolve root through it), spec version list incl. v1.4 (isVersionSupported is EXACT-match: ["v1.11","v1.2"] disabled threads)
- [x] 6 new integration tests (60 app green) + HS-A crypto lifecycle re-proven 12.8s

Deviations: none material. In-thread reactions render aggregated but quick-react inside panel deferred to W4b2 picker pass.

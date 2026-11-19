# PROGRESS — W5b spaces + room settings

Branch task/w5b. Source: docs/prd.md §6.3 (Spaces: view/join/nest/read; basic space create + add rooms — MVP) + wave W5b mission brief.

## Checklist (from PRD + mission)

### Spaces
- [ ] S1 top-level `m.space` rooms render in the spaces rail (real, not the scaffold list); Home remains
- [ ] S2 space child rooms via `m.space.child` state — ordered (order → ts fallback), nested spaces folded one level
- [ ] S3 create space — private + public (POST /createRoom with room_type m.space)
- [ ] S4 add existing room to a space (send `m.space.child` with via)
- [ ] S5 remove room from a space (empty-content `m.space.child`)
- [ ] S6 leave / forget space (POST /leave, /forget)
- [ ] S7 DMs never appear inside space sections (pure fn + UI + test)
- [ ] S8 joined spaces do not double-render as room rows

### Room settings
- [ ] R1 settings panel/modal for active room, registered through panel-tab seam
- [ ] R2 rename (m.room.name state)
- [ ] R3 topic (m.room.topic state)
- [ ] R4 avatar set/replace via W4c media upload pipeline (m.room.avatar), + remove
- [ ] R5 member list (joined/invited/invited-you)
- [ ] R6 leave room + forget checkbox
- [ ] R7 power-level awareness: inputs disabled when `maySendStateEvent` false (Element behavior mirror; server enforces)

### Tests / gates
- [ ] T1 pure space-tree unit tests (sections, nesting one level, ordering, DM exclusion, cycles, removed children)
- [ ] T2 fake-HS extension: /createRoom (+initial_state, room_type), state-store seeding, leave/forget routes, space/power-level options in makeSyncSnapshot
- [ ] T3 spaces UI integration tests over fake HS (create/add/remove/leave/forget echo)
- [ ] T4 settings action tests over fake HS (name/topic/avatar/members/leave+forget/PL-disabled)
- [ ] G1 `pnpm -r build` green
- [ ] G2 `pnpm -r typecheck` green
- [ ] G3 `pnpm -r test` green (app was 97/97 pre-wave)

## Findings to date
- matrix-js-sdk 45.1.0: `sendStateEvent(roomId, type, content, stateKey?)` (roomId FIRST — older docs vary);
  `RoomType.Space` via `room.isSpaceRoom()` reads `m.room.create` content `type` (creation_content.type);
  `EventType.SpaceChild = "m.space.child"` exists in the enum; RoomState.maySendStateEvent(type, userId) available;
  `client.createRoom(ICreateRoomOpts)` exists, `client.createSpace` does NOT (Element-only helper) → build our own.

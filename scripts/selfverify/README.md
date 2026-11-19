# Self-verification two-process probe (W5a-3 debugging tool)

Reproduces the exact live protocol the security module drives, OUTSIDE the
app, for debugging crypto flows without a browser:

    cd packages/core && pnpm build        # device-a.mjs imports ../dist
    cd scripts/selfverify
    LINNET_TEST_HS=http://192.168.50.70:8023 node device-a.mjs

device-a registers a user, spawns device-b (child process = independent wasm
crypto store — REQUIRED: two clients bootstrapping one account in ONE process
make rust wipe the first machine's private cross-signing keys), bootstraps
cross-signing on A only, then SAS-verifies B and asserts B's verified flag.

Exit 0 = full success. The same flow is locked in by
packages/core/src/e2ee.test.ts (LINNET_TEST_HS-gated).

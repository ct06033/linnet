#!/usr/bin/env node
// PRD section 7 performance harness — wave 1 stub.
// Real baselines land with the live-baseline wave (seeded account, fixed runner).
console.log("harness: no baseline yet");
console.log("planned gates (hypotheses until measured, PRD 7):");
console.log("  login->interactive <= 800ms fresh / <= 1.5s on 500-room account");
console.log("  steady-state RAM <= 350MB (500 rooms / 10k-event timeline)");
console.log("  timeline scroll 60fps at 10k events virtualized; idle sync CPU <= 5%");
console.log("  initial JS <= 1MB gz, everything else lazy chunks");

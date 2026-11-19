/**
 * Boot-time registration against the core seam. First-party features MUST use
 * exactly this path (PRD §6.9 — API honesty). Wave 1 ships one demo module so
 * the Ctrl+K palette proves the plumbing.
 */
import { ModuleRegistry, type LinnetModule } from "@linnet/core";

const echoModule: LinnetModule = {
  id: "linnet.echo",
  contributions: () => [
    {
      slot: "slash-command",
      command: "/echo",
      description: "Echo args back (demo module)",
      run: (args) => args,
    },
    {
      slot: "event-handler",
      event: "session.switched",
      handler: () => {
        /* account-switcher hook placeholder */
      },
    },
  ],
};

export async function bootRegistry(): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry({ flags: {}, config: {} });
  await registry.register(echoModule);
  // lazy: await registry.registerLazy("linnet.calls", () => import("./modules/calls.js"))
  return registry;
}

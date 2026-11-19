/**
 * Linnet module registry — the extensibility seam (PRD §6.9, Decision #10).
 * Every feature (first-party or later third-party) contributes to typed slots.
 * Renderer-agnostic: render payloads are typed as unknown here; UI packages cast.
 */
export type SlotName =
  | "timeline-item"
  | "composer-command"
  | "panel-tab"
  | "settings-section"
  | "slash-command"
  | "event-handler";

export interface ModuleContext {
  /** feature flags resolved from config (module.flags gate registration) */
  flags: Record<string, boolean>;
  config: Record<string, unknown>;
}

export interface TimelineItemContribution {
  slot: "timeline-item";
  kind: string;
  render: (props: unknown) => unknown;
}
export interface ComposerCommandContribution {
  slot: "composer-command";
  label: string;
  run: (ctx: unknown) => void | Promise<void>;
}
export interface PanelTabContribution {
  slot: "panel-tab";
  id: string;
  label: string;
  render: (props: unknown) => unknown;
}
export interface SettingsSectionContribution {
  slot: "settings-section";
  id: string;
  title: string;
  render: (props: unknown) => unknown;
}
export interface SlashCommandContribution {
  slot: "slash-command";
  command: string; // e.g. "/echo"
  description?: string;
  run: (args: string, ctx: unknown) => string | void | Promise<string | void>;
}
export interface EventHandlerContribution {
  slot: "event-handler";
  event: string;
  handler: (payload: unknown) => void;
}

export type Contribution =
  | TimelineItemContribution
  | ComposerCommandContribution
  | PanelTabContribution
  | SettingsSectionContribution
  | SlashCommandContribution
  | EventHandlerContribution;

export interface LinnetModule {
  id: string;
  /** all listed flags must be true for registration to take effect */
  flags?: string[];
  contributions: (ctx: ModuleContext) => Contribution[] | Promise<Contribution[]>;
}

export class ModuleRegistry {
  private entries = new Map<string, Contribution[]>();
  private disabled = new Set<string>();
  constructor(private ctx: ModuleContext) {}

  async register(module: LinnetModule): Promise<void> {
    if (this.entries.has(module.id)) {
      throw new Error(`module "${module.id}" already registered`);
    }
    const gated = (module.flags ?? []).every((f) => this.ctx.flags[f] === true);
    const contributions = gated ? await module.contributions(this.ctx) : [];
    this.entries.set(module.id, contributions);
  }

  /** lazy registration behind a dynamic-import seam (boot path stays small) */
  async registerLazy(
    id: string,
    loader: () => Promise<LinnetModule | { default: LinnetModule }>,
  ): Promise<void> {
    const mod = await loader();
    const resolved = "default" in mod ? mod.default : mod;
    await this.register({ ...resolved, id }); // config-facing id is the control key
  }

  disable(id: string): void {
    if (!this.entries.has(id)) throw new Error(`module "${id}" not registered`);
    this.disabled.add(id);
  }
  enable(id: string): void {
    if (!this.entries.has(id)) throw new Error(`module "${id}" not registered`);
    this.disabled.delete(id);
  }
  isEnabled(id: string): boolean {
    return this.entries.has(id) && !this.disabled.has(id);
  }
  moduleIds(): string[] {
    return [...this.entries.keys()];
  }

  list<S extends SlotName>(slot: S): Extract<Contribution, { slot: S }>[] {
    const out: Contribution[] = [];
    for (const [id, cs] of this.entries) {
      if (this.disabled.has(id)) continue;
      for (const c of cs) if (c.slot === slot) out.push(c);
    }
    return out as Extract<Contribution, { slot: S }>[];
  }

  dispatch(event: string, payload: unknown): void {
    for (const h of this.list("event-handler")) {
      if (h.event === event) h.handler(payload);
    }
  }
}

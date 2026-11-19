/**
 * config.json loading + .well-known homeserver discovery (docs/config.md).
 */
export interface LinnetConfig {
  defaultHomeServer?: string;
  /** module id -> enabled */
  modules?: Record<string, boolean>;
  /** feature flag -> enabled */
  features?: Record<string, boolean>;
  [k: string]: unknown;
}

export function parseConfig(jsonText: string): LinnetConfig {
  const raw: unknown = JSON.parse(jsonText);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.json must be a JSON object");
  }
  const cfg = raw as LinnetConfig;
  if (cfg.defaultHomeServer !== undefined && typeof cfg.defaultHomeServer !== "string") {
    throw new Error("defaultHomeServer must be a string");
  }
  for (const key of ["modules", "features"] as const) {
    const v = cfg[key];
    if (v !== undefined) {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`${key} must be an object of booleans`);
      }
      for (const [k, b] of Object.entries(v)) {
        if (typeof b !== "boolean") throw new Error(`${key}.${k} must be boolean`);
      }
    }
  }
  return cfg;
}

/**
 * Resolve a homeserver base URL from <origin>/.well-known/matrix/client.
 * Returns null when absent/unreachable; throws never.
 */
export async function discoverHomeserver(
  origin: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://${origin}/.well-known/matrix/client`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      "m.homeserver"?: { base_url?: string };
    };
    const url = body?.["m.homeserver"]?.base_url;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

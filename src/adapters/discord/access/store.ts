/** @file Validate and atomically persist per-guild feature access policies for roles and users. */
import { rename } from "node:fs/promises";
import { resolvePath } from "../../../core/paths.ts";

/** Independently controlled Discord capabilities. */
export const accessFeatures = ["model", "voice", "tts", "music"] as const;
export type AccessFeature = (typeof accessFeatures)[number];
/** A whitelist permits any matching role or user; a blacklist rejects any match. */
export type AccessRule = { mode: "whitelist" | "blacklist"; roles: string[]; users: string[] };
export type AccessSettings = Partial<Record<AccessFeature, AccessRule>>;

/** Recognize a configurable feature without accepting inherited object properties. */
export function isAccessFeature(value: string): value is AccessFeature {
  return accessFeatures.some((feature) => feature === value);
}

/** Validate disk data and return an independent policy snapshot. Missing rules allow everyone. */
function parseSettings(data: unknown): AccessSettings {
  const saved = data as { version?: unknown; rules?: unknown };
  if (
    !saved ||
    saved.version !== 1 ||
    !saved.rules ||
    typeof saved.rules !== "object" ||
    Array.isArray(saved.rules)
  )
    throw new Error("Некорректный файл настроек доступа.");
  const rules: AccessSettings = {};
  for (const [feature, value] of Object.entries(saved.rules)) {
    const rule = value as AccessRule;
    if (
      !isAccessFeature(feature) ||
      !rule ||
      !["whitelist", "blacklist"].includes(rule.mode) ||
      !Array.isArray(rule.roles) ||
      rule.roles.length > 100 ||
      !Array.isArray(rule.users) ||
      rule.roles.length + rule.users.length > 100 ||
      [...rule.roles, ...rule.users].some((id) => typeof id !== "string" || !/^\d{1,20}$/.test(id))
    )
      throw new Error("Некорректное правило доступа.");
    rules[feature] = {
      mode: rule.mode,
      roles: [...new Set(rule.roles)],
      users: [...new Set(rule.users)],
    };
  }
  return rules;
}

/** Evaluate one feature. Administrators always retain access; @everyone uses the guild ID. */
export function allowsFeature(
  rule: AccessRule | undefined,
  roles: Iterable<string>,
  guildId: string,
  userId: string,
  administrator = false,
): boolean {
  if (administrator || !rule) return true;
  const ids = new Set([guildId, ...roles]);
  const matches = rule.users.includes(userId) || rule.roles.some((id) => ids.has(id));
  return rule.mode === "whitelist" ? matches : !matches;
}

/** Create storage with serialized writes per guild. Failed reads/writes never replace saved rules.
 * An omitted directory provides transient storage for embedded clients and tests. */
export function createDiscordAccessStore(directory?: string) {
  const cache = new Map<string, AccessSettings>();
  const pending = new Map<string, Promise<unknown>>();
  const guildFile = (guildId: string) => {
    if (!/^\d{1,20}$/.test(guildId)) throw new Error("Некорректный ID сервера.");
    return resolvePath(`access_${guildId}.json`, directory);
  };
  async function read(guildId: string): Promise<AccessSettings> {
    const cached = cache.get(guildId);
    if (cached) return structuredClone(cached);
    if (!directory) return {};
    let rules: AccessSettings;
    try {
      rules = parseSettings(await Bun.file(guildFile(guildId)).json());
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      rules = {};
    }
    // Concurrent readers must not overwrite a newer committed write.
    if (!cache.has(guildId)) cache.set(guildId, rules);
    return structuredClone(cache.get(guildId));
  }
  return {
    /** Read the current independent snapshot, waiting for preceding edits. */
    async get(guildId: string) {
      await pending.get(guildId)?.catch(() => {});
      return read(guildId);
    },
    /** Replace or reset one feature; commit in memory only after atomic disk replacement. */
    async set(guildId: string, feature: AccessFeature, rule?: AccessRule) {
      const task = (pending.get(guildId) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const rules = await read(guildId);
          if (rule) rules[feature] = structuredClone(rule);
          else delete rules[feature];
          const validated = parseSettings({ version: 1, rules });
          if (directory) {
            const file = guildFile(guildId);
            await Bun.write(
              `${file}.tmp`,
              JSON.stringify({ version: 1, rules: validated }, null, 2),
              { createPath: true },
            );
            await rename(`${file}.tmp`, file);
          }
          cache.set(guildId, validated);
        });
      pending.set(guildId, task);
      try {
        await task;
      } finally {
        if (pending.get(guildId) === task) pending.delete(guildId);
      }
    },
    /** Await accepted settings changes before disconnecting the adapter. */
    async close() {
      await Promise.allSettled(pending.values());
    },
  };
}

/** @file Verify persisted access policies, matching precedence and failure-safe edits. */
import { expect, test } from "bun:test";
import { temporaryDirectory } from "../support/temp.ts";
import {
  allowsFeature,
  createDiscordAccessStore,
} from "../../src/adapters/discord/access/store.ts";

test("whitelist and blacklist match any role or user, with explicit administrator access", () => {
  for (const mode of ["whitelist", "blacklist"] as const) {
    const rule = { mode, roles: ["20"], users: ["30"] };
    const matching = mode === "whitelist";
    expect(allowsFeature(rule, ["20", "21"], "10", "40")).toBe(matching);
    expect(allowsFeature(rule, [], "10", "30")).toBe(matching);
    expect(allowsFeature(rule, ["21"], "10", "40")).toBe(!matching);
    expect(allowsFeature(rule, [], "10", "30", true)).toBe(true);
    expect(allowsFeature({ mode, roles: [], users: [] }, [], "10", "40")).toBe(!matching);
    expect(allowsFeature({ mode, roles: ["10"], users: [] }, [], "10", "40")).toBe(matching);
  }
  expect(allowsFeature(undefined, [], "10", "40")).toBe(true);
});

test("concurrent edits persist independent features and guilds, snapshots cannot mutate policy", async () => {
  const directory = await temporaryDirectory("discord-access-");
  const store = createDiscordAccessStore(directory);
  expect(await store.get("10")).toEqual({});
  await Promise.all([
    store.set("10", "model", { mode: "whitelist", roles: ["20", "20"], users: ["30"] }),
    store.set("10", "music", { mode: "blacklist", roles: [], users: ["40"] }),
    store.set("11", "voice", { mode: "whitelist", roles: [], users: [] }),
  ]);
  const snapshot = await store.get("10");
  snapshot.model.roles.push("99");
  const restored = createDiscordAccessStore(directory);
  expect(await restored.get("10")).toEqual({
    model: { mode: "whitelist", roles: ["20"], users: ["30"] },
    music: { mode: "blacklist", roles: [], users: ["40"] },
  });
  expect(await restored.get("11")).toEqual({ voice: { mode: "whitelist", roles: [], users: [] } });
  await store.set("10", "model");
  expect((await createDiscordAccessStore(directory).get("10")).model).toBeUndefined();
  expect((await store.get("10")).music).toBeDefined();
});

test("corrupt settings and invalid changes never open access or overwrite saved data", async () => {
  const directory = await temporaryDirectory("discord-access-corrupt-");
  const file = `${directory}/access_10.json`;
  await Bun.write(file, '{"version":999,"rules":{}}');
  const store = createDiscordAccessStore(directory);
  await expect(store.get("10")).rejects.toThrow();
  await expect(store.set("10", "music")).rejects.toThrow();
  expect(await Bun.file(file).text()).toBe('{"version":999,"rules":{}}');
  await expect(store.get("../10")).rejects.toThrow();
  const healthy = createDiscordAccessStore(directory);
  await healthy.set("11", "tts", { mode: "blacklist", roles: [], users: ["30"] });
  await expect(
    healthy.set("11", "tts", { mode: "whitelist", roles: ["invalid"], users: [] }),
  ).rejects.toThrow();
  expect((await healthy.get("11")).tts.mode).toBe("blacklist");
  // A rejected edit does not prevent the next valid edit from committing.
  await healthy.set("11", "tts");
  expect(await healthy.get("11")).toEqual({});
});

test("a failed atomic replacement preserves the in-memory policy", async () => {
  const directory = await temporaryDirectory("discord-access-write-");
  const store = createDiscordAccessStore(directory);
  await store.set("10", "model", { mode: "whitelist", roles: [], users: ["30"] });
  // Turn the temporary destination into a directory to produce a real write failure.
  await Bun.$`mkdir ${directory + "/access_10.json.tmp"}`.quiet();
  await expect(store.set("10", "model")).rejects.toThrow();
  expect((await store.get("10")).model).toEqual({ mode: "whitelist", roles: [], users: ["30"] });
  expect((await createDiscordAccessStore(directory).get("10")).model.users).toEqual(["30"]);
});

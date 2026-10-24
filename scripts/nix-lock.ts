/** @file Regenerate the npm lock consumed by Nix from the authoritative Bun lock. */
export {};
type LockEntry = [string, string, Record<string, unknown>, string];
const lock = Bun.JSON5.parse(await Bun.file("bun.lock").text()) as {
  workspaces: Record<string, Record<string, unknown>>;
  packages: Record<string, LockEntry>;
};
const packages: Record<string, unknown> = { "": { ...lock.workspaces[""], version: "1.0.0" } };
for (const [key, entry] of Object.entries(lock.packages) as [
  string,
  [string, string, Record<string, unknown>, string],
][]) {
  const [spec, , metadata, integrity] = entry;
  const split = spec.lastIndexOf("@");
  const name = spec.slice(0, split),
    version = spec.slice(split + 1);
  const path = "node_modules/" + key;
  const parts = key.split("/");
  // Bun uses parent/package keys for nested dependency overrides.
  const actualPath = key.startsWith("@")
    ? parts.length > 2
      ? `node_modules/${parts.slice(0, 2).join("/")}/node_modules/${parts.slice(2).join("/")}`
      : path
    : parts.length > 1
      ? `node_modules/${parts[0]}/node_modules/${parts.slice(1).join("/")}`
      : path;
  for (const field of ["os", "cpu"])
    if (typeof metadata[field] === "string") metadata[field] = [metadata[field]];
  if (Array.isArray(metadata.optionalPeers)) {
    metadata.peerDependenciesMeta = Object.fromEntries(
      metadata.optionalPeers.map((name) => [name, { optional: true }]),
    );
    delete metadata.optionalPeers;
  }
  if (metadata.os || metadata.cpu) metadata.optional = true;
  packages[actualPath] = {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
    integrity,
    ...metadata,
  };
}
await Bun.write(
  "nix/package-lock.json",
  JSON.stringify(
    { name: "relaksacher", version: "1.0.0", lockfileVersion: 3, requires: true, packages },
    null,
    2,
  ) + "\n",
);

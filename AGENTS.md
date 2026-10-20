# Runtime conventions

Prefer Bun-native APIs for new code and refactors: `Bun.file`, `Bun.write`,
`Bun.spawn`, `Bun.env`, and Bun's test runner. Use standard Web APIs for streams,
HTTP, URLs, and cancellation where appropriate.

Keep Node compatibility APIs where Bun has no suitable native replacement or a
library requires them. In particular, preserve atomic file replacement with
`node:fs/promises.rename`, terminal raw-mode/key handling, and the readable-stream
adapter required by `@discordjs/voice`. Avoid adding shell processes just to
remove a necessary Node import.

Run `bun run lint`, `bun run typecheck` and the relevant `bun test` checks after
behavioral changes. Keep lint warnings at zero; document any narrowly scoped
rule suppression next to the code.

Document module responsibilities and public function contracts. Update user-facing
command documentation when behavior changes. Format edits with `bun run format`
and verify them with `bun run format:check`.

Keep every TypeScript source, test and tooling file at or below 600 physical
lines, including comments and blank lines. Prefer modules of 200–400 lines split
by responsibility. `bun run check:size` enforces the limit and runs as part of
`bun run lint`; do not compress formatting or remove useful documentation to pass.

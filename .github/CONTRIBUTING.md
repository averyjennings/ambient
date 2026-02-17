# Contributing to Ambient

## Setup

```bash
git clone https://github.com/averyjennings/ambient.git
cd ambient
pnpm install
pnpm build
```

## Development

```bash
pnpm dev          # watch mode (recompiles on save)
pnpm typecheck    # type check without emitting
pnpm test         # run all tests
pnpm test:watch   # watch mode tests
```

After changes, reload the running daemon:

```bash
pnpm reload       # rebuild + restart daemon + re-source shell
```

## Code style

- ESM throughout (`"type": "module"`) — all imports use `.js` extensions
- Strict TypeScript (`noUncheckedIndexedAccess`, `noUnusedLocals`)
- Two runtime dependencies only: `@modelcontextprotocol/sdk` and `zod`
- Keep files under 500 lines
- No lint config — use `pnpm typecheck` for validation

## Testing

Tests use vitest and live in `tests/`. Run a single file with:

```bash
vitest run tests/memory/store.test.ts
```

All tests use temp directories with cleanup. No network calls, no daemon dependency.

## Before submitting

1. `pnpm typecheck` passes
2. `pnpm test` passes (379+ tests)
3. `pnpm build` succeeds
4. Manual smoke test: `r daemon stop && r daemon start && r "hello"`

## Architecture

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how the pieces fit together.

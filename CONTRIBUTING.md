# Contributing to batonpass

## Setup

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Node.js 24 or later. Sources are TypeScript run directly by Node (erasable syntax only: no `enum`, no parameter properties, no namespaces; relative imports end in `.ts`).

## Rules

- Tests first. Every change comes with a test that failed before it.
- Fixtures are synthetic. Never commit a real transcript, and assemble secret-shaped test values from fragments; `tests/secret-scan.test.ts` fails on any secret-shaped string in docs, fixtures, integrations or scorecards.
- Transcripts are read-only inputs. No code path may write, move or delete them.
- Tool outputs are never stored or sent anywhere.
- Hooks never fail a session: any error returns empty output.
- Runtime dependencies stay at two (`fast-jev-compaction`, `smol-toml`). Discuss any addition in an issue first.

## Adding an agent

See [docs/writing-a-reader.md](docs/writing-a-reader.md).

## Changing selection or rendering

Run `baton eval --out evals/results` with and without your change and include both scorecards in the pull request. A change that lowers recall of the default strategy is not merged.

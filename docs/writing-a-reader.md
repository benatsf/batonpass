# Writing a reader for another agent

A reader turns one agent's transcript lines into batonpass events. Everything else (redaction, storage, selection, rendering, hooks) is shared.

## The interface

```ts
interface SourceReader {
  tool: string;                                            // short id, e.g. 'gemini'
  discover(): SourceFile[];                                // transcript files, oldest first
  initialState(file: SourceFile): ParseState;             // session id and cwd before the first line
  parse(line: string, state: ParseState): BatonEvent[];   // one JSONL line; may update state
  sessionTitles?(): Map<string, string>;                   // optional session names
}
```

Emit `user` for real user prompts only (not injected context, not tool results), `final` or `assistant` for the agent's text replies, `tool_call` with a short `name input` text, and `goal`, `compaction`, `title`, `pr`, `usage`, `cwd_change` when the format has them. Never emit tool outputs. Ignore user lines that start with `<baton-context`.

## Fixture-first workflow

1. Study a real transcript locally, but never commit one. Write down each line type you need.
2. Extend `src/script.ts` with a builder that writes a synthetic session in your agent's format, or add a synthetic fixture under `tests/fixtures/<tool>/`. Assemble any secret-shaped test value from fragments (`'sk_' + 'live_' + …`).
3. Write the reader test first: the exact events you expect, that tool output never appears, and that malformed lines throw (ingest counts and skips them).
4. Implement `src/readers/<tool>.ts`, register it in `createContext` (`src/context.ts`), and add a `toolLabel` in `src/select/dialogue.ts`.
5. Add an evaluation case in `evals/cases/` that mixes your agent with Codex or Claude Code, and run `npm test`.

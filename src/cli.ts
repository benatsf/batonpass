import { spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { doctor, ingestCommand, note, resume, search, show, status, type Command } from './commands.ts';
import { defaultConfig, ensureHome, loadConfig } from './config.ts';
import { createContext, type Context } from './context.ts';
import { CASES_DIR, commandAnswerer, loadCases, renderScorecard, runEval, STRATEGIES, writeScorecard, type Strategy } from './eval.ts';
import { normalizeEvent, runHook } from './hooks.ts';
import { applyPlan, defaultLauncher, installPaths, planInstall, planUninstall, renderDiff, SKILL_SOURCE } from './install.ts';

export const VERSION = '0.1.0';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn(cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<number>;
  /** Runs `baton <args>` in its own process group, outliving this process. */
  spawnDetached(args: string[], env: NodeJS.ProcessEnv): void;
}

let stdoutGuarded = false;

/** A reader that stops early (`baton status | head`) closes the pipe; that is not an error. */
function guardStdout(): void {
  if (stdoutGuarded) return;
  stdoutGuarded = true;
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

export function defaultIO(): CliIO {
  guardStdout();
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    readStdin: async () => {
      if (process.stdin.isTTY) return '';
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    cwd: process.cwd(),
    env: process.env,
    spawn: (cmd, args, options) =>
      new Promise((resolve) => {
        const child = spawnProcess(cmd, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(127));
      }),
    spawnDetached: (args, env) => {
      const child = spawnProcess(process.execPath, [process.argv[1]!, ...args], { detached: true, env, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    },
  };
}

export function captureIO(overrides: Partial<CliIO> = {}): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (text) => void stdout.push(text),
    err: (text) => void stderr.push(text),
    readStdin: async () => '',
    cwd: process.cwd(),
    env: { ...process.env },
    spawn: async () => 0,
    spawnDetached: () => {},
    ...overrides,
  };
}

export type ContextFactory = (env: NodeJS.ProcessEnv) => Context;

const COMMANDS: Record<string, Command> = { status, show, ingest: ingestCommand, search, note, resume, doctor };

async function hookCommand(args: string[], io: CliIO, makeContext: ContextFactory): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args, options: { tool: { type: 'string' } }, allowPositionals: true, strict: false });
    const tool = values.tool === 'codex' ? 'codex' : 'claude';
    const event = String(positionals[0] ?? '');
    const detachedRun = io.env.BATON_DETACHED === '1';
    const input = detachedRun ? (io.env.BATON_HOOK_INPUT ?? '') : await io.readStdin();
    // A tool may end the session right after Stop (`claude -p`, closing the app), killing
    // its hook processes. The refresh therefore runs in a detached process of its own.
    if (normalizeEvent(event) === 'stop' && !detachedRun) {
      io.spawnDetached(['hook', ...args], { ...io.env, BATON_DETACHED: '1', BATON_HOOK_INPUT: input });
      return 0;
    }
    const out = await runHook(event, tool, input, () => makeContext(io.env));
    if (out) io.out(`${out}\n`);
  } catch {
    // A hook never fails the calling session.
  }
  return 0;
}

function installCommand(args: string[], io: CliIO, uninstall: boolean): number {
  const { values } = parseArgs({ args, options: { claude: { type: 'boolean' }, codex: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  const config = loadConfig(io.env);
  ensureHome(config.home);
  const paths = installPaths(io.env, config.home);
  const target = values.claude || values.codex ? { claude: Boolean(values.claude), codex: Boolean(values.codex) } : { claude: true, codex: true };
  const now = new Date();
  const plan = uninstall ? planUninstall(paths) : planInstall(paths, target, defaultLauncher(), readFileSync(SKILL_SOURCE, 'utf8'), now);
  if (plan.changes.length) io.out(`${renderDiff(plan.changes)}\n\n`);
  else io.out('Nothing to change.\n');
  if (values['dry-run']) {
    io.out('Dry run: nothing was written.\n');
    return 0;
  }
  applyPlan(paths, plan, now);
  for (const line of plan.notes) io.out(`${line}\n`);
  return 0;
}

async function evalCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { strategy: { type: 'string', multiple: true }, fixtures: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' } },
  });
  if (io.env.BATON_HOOK === '1') {
    io.err('baton eval is disabled inside an agent started by baton (BATON_HOOK=1).\n');
    return 1;
  }
  const strategies = (values.strategy ?? STRATEGIES) as Strategy[];
  const unknown = strategies.filter((s) => !STRATEGIES.includes(s));
  if (unknown.length) {
    io.err(`Unknown strategy: ${unknown.join(', ')}. Choose from ${STRATEGIES.join(', ')}.\n`);
    return 2;
  }
  const config = loadConfig(io.env);
  ensureHome(config.home);
  const cases = loadCases(values.fixtures ?? CASES_DIR);
  const answer = commandAnswerer(config.eval.answerCommand, io.env, mkdtempSync(join(tmpdir(), 'baton-eval-answers-')));
  const card = await runEval({
    cases,
    strategies,
    answer,
    answerCommand: config.eval.answerCommand.join(' '),
    env: io.env,
    concurrency: Number(values.concurrency ?? 4) || 4,
  });
  const written = writeScorecard(card, values.out ?? join(config.home, 'evals'));
  io.out(renderScorecard(card, defaultConfig(config.home, io.env).select.strategy));
  io.out(`\nWrote ${written.markdown}\n`);
  return 0;
}

const USAGE = `Usage: baton <command> [options]

Commands:
  status                         Projects, sessions, snapshot age, Jev spend today
  show [--full] [--project id]   Print the latest snapshot for this project
  ingest [--all] [--project id]  Read new transcript lines and render snapshots now
  search <words…>                Search this project's redacted history
  note <text…>                   Pin a note into every future snapshot of this project
  resume <codex|claude>          Start the other tool here, primed with the brief
  doctor                         Check installation and data health
  install | uninstall            Add or remove hooks and the baton-resume skill
  eval                           Run the recall evaluation
  hook <event> --tool <tool>     Hook entry point (called by Codex and Claude Code)
`;

export async function main(argv: string[], io: CliIO = defaultIO(), makeContext: ContextFactory = (env) => createContext(env)): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case '--version':
    case '-v':
      io.out(`${VERSION}\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    case 'hook':
      return hookCommand(rest, io, makeContext);
    case 'eval':
      try {
        return await evalCommand(rest, io);
      } catch (error) {
        io.err(`${error instanceof Error ? error.message : String(error)}\n`);
        return (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1;
      }
    case 'install':
    case 'uninstall':
      try {
        return installCommand(rest, io, command === 'uninstall');
      } catch (error) {
        io.err(`${error instanceof Error ? error.message : String(error)}\n`);
        return (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1;
      }
  }
  const run = COMMANDS[command];
  if (!run) {
    io.err(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  let ctx: Context | null = null;
  try {
    ctx = makeContext(io.env);
    return await run(ctx, io, rest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code.startsWith('ERR_PARSE_ARGS')) {
      io.err(`${(error as Error).message}\n`);
      return 2;
    }
    io.err(`baton ${command} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    ctx?.close();
  }
}

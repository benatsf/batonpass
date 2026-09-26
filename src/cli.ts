import { spawn as spawnProcess } from 'node:child_process';

export const VERSION = '0.1.0';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn(cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<number>;
}

export function defaultIO(): CliIO {
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
    ...overrides,
  };
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

export async function main(argv: string[], io: CliIO = defaultIO()): Promise<number> {
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
    default:
      void rest;
      io.err(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

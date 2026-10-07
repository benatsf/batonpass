import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { CliIO } from './cli.ts';
import type { Check } from './commands.ts';
import { ensureHome, loadConfig } from './config.ts';
import { appendLog } from './context.ts';
import { agentPlist, AGENT_LABEL, applySync, backupStore, desktopPaths, planSync, type DesktopPaths, type Folder, type SyncPlan } from './desktop.ts';
import { installPaths } from './install.ts';
import { tryLock } from './lock.ts';

const USAGE = `Usage: baton desktop <command>

Keeps every Claude desktop Code-tab session visible in every Claude account signed in on this Mac.

Commands:
  status               Account folders, and what the next sync would do (default)
  sync [--dry-run]     Copy, update and hide session records across accounts now
  enable               Back up the session list, then sync every minute in the background
  disable              Stop the background sync (copies already made stay)
`;

const short = (f: Folder) => `${f.account.slice(0, 8)}…/${f.org.slice(0, 8)}…`;

function renderPlan(plan: SyncPlan): string {
  const counts = { create: 0, update: 0, quarantine: 0 };
  for (const a of plan.actions) counts[a.kind]++;
  const lines = [`copy ${counts.create}, update ${counts.update}, hide ${counts.quarantine}; ${plan.skipped.length} skipped`];
  const label = { create: 'copy  ', update: 'update', quarantine: 'hide  ' };
  for (const a of plan.actions) lines.push(`  ${label[a.kind]} → ${short(a.folder)}  ${a.title}`);
  for (const s of plan.skipped) lines.push(`  skip     ${s.title} (${s.reason})`);
  return lines.join('\n');
}

function renderLayout(plan: SyncPlan): string {
  const { layout } = plan;
  if (!layout.folders.length) return 'No Code-tab sessions found on this Mac.';
  return layout.folders
    .map((f) => `  ${short(f)}  ${f === layout.active ? '(loaded in Claude)' : ''}`.trimEnd())
    .join('\n');
}

const uid = () => process.getuid?.() ?? 501;

async function startAgent(paths: DesktopPaths, io: CliIO, launcher: string, home: string): Promise<boolean> {
  mkdirSync(dirname(paths.agent), { recursive: true });
  writeFileSync(paths.agent, agentPlist(launcher, home, join(home, 'logs', 'desktop-sync.err')), { mode: 0o644 });
  await io.spawn('launchctl', ['bootout', `gui/${uid()}/${AGENT_LABEL}`], { cwd: io.cwd, env: io.env });
  return (await io.spawn('launchctl', ['bootstrap', `gui/${uid()}`, paths.agent], { cwd: io.cwd, env: io.env })) === 0;
}

export async function stopAgent(paths: DesktopPaths, io: CliIO): Promise<boolean> {
  if (!existsSync(paths.agent)) return false;
  await io.spawn('launchctl', ['bootout', `gui/${uid()}/${AGENT_LABEL}`], { cwd: io.cwd, env: io.env });
  rmSync(paths.agent, { force: true });
  return true;
}

type Run = { busy: true } | { busy: false; plan: SyncPlan; result?: ReturnType<typeof applySync> };

function sync(paths: DesktopPaths, home: string, now: Date, dryRun: boolean): Run {
  const lock = tryLock(join(home, 'locks', 'desktop-sync.lock'));
  if (!lock) return { busy: true };
  try {
    const plan = planSync(paths, now.getTime());
    if (dryRun || !plan.actions.length) return { busy: false, plan };
    const result = applySync(paths, plan, now);
    appendLog(home, 'desktop-sync', { ...result });
    return { busy: false, plan, result };
  } finally {
    lock.release();
  }
}

export function desktopChecks(env: NodeJS.ProcessEnv, home: string, claudeProjects: string): Check[] {
  const paths = desktopPaths(env, home, claudeProjects);
  if (!existsSync(paths.agent)) return [];
  const errors = join(home, 'logs', 'desktop-sync.err');
  const failing = existsSync(errors) && statSync(errors).size > 0;
  return [
    [true, 'Claude desktop session sync: on (every minute)'],
    ...(failing ? [[false, `Claude desktop session sync reported errors: see ${errors} (delete it once fixed)`] as Check] : []),
  ];
}

export async function desktopCommand(args: string[], io: CliIO, now: () => Date = () => new Date()): Promise<number> {
  const [sub = 'status', ...rest] = args;
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    io.out(USAGE);
    return 0;
  }
  const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' }, quiet: { type: 'boolean' } } });
  if (process.platform !== 'darwin') {
    io.err('baton desktop works with the Claude desktop app on macOS only.\n');
    return 1;
  }
  const config = loadConfig(io.env);
  ensureHome(config.home);
  const paths = desktopPaths(io.env, config.home, config.sources.claudeProjects);

  switch (sub) {
    case 'status': {
      const plan = planSync(paths, now().getTime());
      io.out(`Code-tab session folders (account/org):\n${renderLayout(plan)}\n\n`);
      io.out(`Background sync: ${existsSync(paths.agent) ? 'on, every minute' : 'off (`baton desktop enable` turns it on)'}\n`);
      if (plan.layout.settling) io.out('Claude is switching accounts; nothing would run right now.\n');
      else if (plan.layout.folders.length < 2) io.out('Only one account has used the Code tab here, so there is nothing to sync yet.\n');
      else io.out(`Next sync would: ${renderPlan(plan)}\n`);
      return 0;
    }
    case 'sync': {
      const run = sync(paths, config.home, now(), Boolean(values['dry-run']));
      if (run.busy) {
        if (!values.quiet) io.out('Another sync is running; try again in a moment.\n');
        return 0;
      }
      if (values.quiet) return 0;
      if (run.plan.layout.settling) io.out('Claude is switching accounts; try again in a few seconds.\n');
      else if (values['dry-run']) io.out(`Dry run, nothing written. Would: ${renderPlan(run.plan)}\n`);
      else if (!run.result) {
        const skipped = run.plan.skipped.length ? `; ${run.plan.skipped.length} skipped for now, see \`baton desktop status\`` : '';
        io.out(`Nothing to do (${run.plan.sessions} sessions in ${run.plan.layout.folders.length} account folders${skipped}).\n`);
      }
      else {
        const r = run.result;
        io.out(`Copied ${r.created}, updated ${r.updated}, hid ${r.quarantined}${r.raced ? `; ${r.raced} left alone because Claude wrote them meanwhile` : ''}.\n${renderPlan(run.plan)}\n`);
      }
      return 0;
    }
    case 'enable': {
      if (!existsSync(paths.store)) {
        io.err('Claude desktop has not stored any Code-tab sessions on this Mac yet.\n');
        return 1;
      }
      const launcher = installPaths(io.env, config.home).launcher;
      if (!existsSync(launcher)) {
        io.err('The batonpass launcher is missing: run `baton install` first.\n');
        return 1;
      }
      const backup = backupStore(paths, now());
      io.out(`Backed up the session list to ${backup}\n`);
      const run = sync(paths, config.home, now(), false);
      if (!run.busy && run.result) io.out(`First sync: copied ${run.result.created}, updated ${run.result.updated}, hid ${run.result.quarantined}.\n`);
      if (!(await startAgent(paths, io, launcher, config.home))) {
        io.err(`launchctl could not load ${paths.agent}.\n`);
        return 1;
      }
      io.out(
        'Background sync is on: every minute, sessions are copied into the other accounts\' folders.\n' +
          'Claude shows them the next time you switch account. `baton desktop status` shows what it does; `baton desktop disable` stops it.\n',
      );
      return 0;
    }
    case 'disable': {
      const stopped = await stopAgent(paths, io);
      io.out(stopped ? 'Background sync is off. Copies already made stay, and so does the backup in ~/.baton/desktop-sync.\n' : 'Background sync was not on.\n');
      return 0;
    }
    default:
      io.err(`Unknown desktop command: ${sub}\n\n${USAGE}`);
      return 2;
  }
}

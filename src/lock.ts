import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Lock {
  release(): void;
}

const STALE_MS = 10 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(path: string, now: () => number): boolean {
  try {
    const pid = Number(readFileSync(path, 'utf8').split(' ')[0]);
    if (now() - statSync(path).mtimeMs > STALE_MS) return true;
    return !Number.isInteger(pid) || pid <= 0 || !alive(pid);
  } catch {
    return true;
  }
}

/**
 * Exclusive, non-blocking lock. Snapshot sequence numbers stay atomic through the
 * ledger transaction either way; the lock only stops two refreshes duplicating work.
 */
export function tryLock(path: string, now: () => number = Date.now): Lock | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid} ${new Date(now()).toISOString()}\n`);
      closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt > 0 || !isStale(path, now)) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

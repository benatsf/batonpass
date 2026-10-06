import { Ledger } from '../../src/ledger.ts';

// Claims pending messages one at a time (maxChars 1) and prints the ids it got, one per line.
const [path, rounds] = process.argv.slice(2);
const ledger = new Ledger(path!);
const ids: number[] = [];
for (let i = 0; i < Number(rounds); i++) {
  for (const m of ledger.claimMessages('p', 'claude', 'test', new Date().toISOString(), { maxChars: 1 })) ids.push(m.id);
}
ledger.close();
process.stdout.write(ids.map((id) => `${id}\n`).join(''));

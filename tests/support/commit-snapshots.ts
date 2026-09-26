import { Ledger } from '../../src/ledger.ts';

const [path, count] = process.argv.slice(2);
const ledger = new Ledger(path!);
for (let i = 0; i < Number(count); i++) {
  ledger.commitSnapshot('p', (seq) => ({ createdAt: new Date().toISOString(), covers: [], brief: `b${seq}`, full: 'f', stats: {} }));
}
ledger.close();

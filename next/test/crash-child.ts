import { lockRun } from '../src/project.ts';
import { Store } from '../src/store.ts';
import { executeRun } from '../src/workflow.ts';

const [db, state, id] = process.argv.slice(2);
if (!db || !state || !id) throw new Error('Fixture arguments missing');
const store = new Store(db);
await lockRun(state, id);
setInterval(() => {}, 1000);
await executeRun(
  store.get(id),
  store,
  {
    async execute() {
      process.stdout.write('READY\n');
      return new Promise(() => {});
    },
  },
  {
    async execute() {
      throw new Error('Not reached');
    },
  },
  new AbortController().signal,
);

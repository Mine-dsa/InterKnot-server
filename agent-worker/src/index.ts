import { runWorkerLoop } from './worker.js';

runWorkerLoop().catch((err) => {
  console.error(err);
  process.exit(1);
});

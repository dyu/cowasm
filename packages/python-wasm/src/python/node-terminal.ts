import { isMainThread } from "node:worker_threads";
import { init, terminal } from "./node";

async function main() {
  await init();
  const r = await terminal(["python"].concat(process.argv.slice(2)));
  process.exit(r);
}

if (isMainThread) {
  main();
}

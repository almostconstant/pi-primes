import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Engine } from "./engine.js";
import { DurableRuntime } from "./runtime.js";
import { JobStore } from "./store.js";
import { serve } from "./server.js";

process.umask(0o077);
const home = process.argv[2];
if (!home) throw new Error("Worker requires state directory; launch through client to acquire worker.lock");
// Host credentials/models are loaded directly, never copied into job records or RPC payloads.
const models = await ModelRuntime.create({ allowModelNetwork: false });
const engine = new Engine(new JobStore(join(home, "jobs")), (directory, job) => DurableRuntime.open(directory, job, models));
await engine.initialize();
const server = await serve(engine, home);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { void server.close().catch(error => { console.error(error); process.exitCode = 1; }); });
}

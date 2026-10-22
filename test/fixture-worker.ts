import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { JobStore } from "../src/store.js";
import { DurableRuntime } from "../src/runtime.js";
import { serve } from "../src/server.js";
import { fixtureModels } from "./helpers.js";

const home = process.argv[2]!;
const models = fixtureModels();
const engine = new Engine(new JobStore(join(home, "jobs")), (directory, job) => DurableRuntime.open(directory, job, models));
await engine.initialize();
const service = await serve(engine, home);
process.send?.("ready");
process.on("SIGTERM", () => { void service.close(); });

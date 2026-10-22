import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "../src/client.js";
import { until } from "./helpers.js";
import type { JobSummary } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixture-worker.ts", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx/esm"));

test("detached lifecycle, durable discovery, questions, worker SIGKILL, unsafe replay and cancellation", { timeout: 45_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "primes-"));
  const client = new Client(home);
  let worker: ChildProcess | undefined;
  let diagnostic = "";
  async function boot() {
    worker = fork(fixture, [home], { execArgv: ["--import", loader], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    worker.stderr!.on("data", chunk => { diagnostic += chunk; });
    await Promise.race([
      once(worker, "message"),
      once(worker, "exit").then(([code]) => { throw new Error(`Fixture exited ${code}: ${diagnostic}`); }),
    ]);
  }
  async function kill(signal: NodeJS.Signals) {
    const exit = once(worker!, "exit");
    worker!.kill(signal); await exit; worker = undefined;
  }
  const input = (goal: string) => ({ goal, context: "", cwd: home,
    owner: { sessionId: "original-parent", sessionFile: null }, model: { provider: "fixture", modelId: "fixture" }, tools: "none" as const });
  t.after(async () => { if (worker) await kill("SIGTERM"); await rm(home, { recursive: true, force: true }); });
  await boot();

  // Parent process exits; worker remains alive and finishes without that parent holding an ID.
  const parent = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import { Client } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).href)};
    await new Client(${JSON.stringify(home)}).start(${JSON.stringify(input("slow independent task"))});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let parentError = "";
  parent.stderr.on("data", chunk => { parentError += chunk; });
  assert.equal((await once(parent, "exit"))[0], 0, parentError);
  let jobs = await until(() => client.list(), jobs => jobs.some(job => job.state === "completed"));
  assert.equal(jobs.length, 1);
  const first = jobs[0]!;
  assert.equal(first.attention?.kind, "completed");
  assert.equal((await client.inspect(first.id)).job.result, "Fixture result");
  assert.equal((await stat(join(home, "worker.sock"))).mode & 0o777, 0o600);
  await assert.rejects(client.acknowledge(first.id, "old-event"), /changed/);
  const adopted = await client.attach(first.id, { sessionId: "new-parent", sessionFile: null });
  assert.equal((await client.inspect(first.id)).job.owner.sessionId, "new-parent");
  await assert.rejects(client.acknowledge(first.id, first.attention!.id), /changed/);
  await client.acknowledge(first.id, adopted.attention!.id);
  assert.equal((await client.list()).length, 0);
  assert.equal((await client.list({ all: true })).length, 1);

  const questionJob = await client.start(input("ask missing context"));
  jobs = await until(() => client.list(), jobs => jobs.some(job => job.state === "waiting_for_input"));
  assert.equal(jobs[0]!.question, "Which audience?");
  await assert.rejects(client.start(input("second")), /One job/);
  await kill("SIGKILL");
  await boot();
  const interrupted = (await client.list())[0]!;
  assert.equal(interrupted.id, questionJob.id);
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.attention?.kind, "interrupted");
  await client.inspect(interrupted.id);
  await sleep(600);
  assert.equal((await client.list())[0]!.state, "interrupted", "inspect must not enable scheduler");
  await client.resume(interrupted.id);
  await until(() => client.list(), jobs => jobs.some(job => job.state === "waiting_for_input"));
  await client.reply(interrupted.id, "Engineers");
  await until(() => client.inspect(interrupted.id), inspection => inspection.job.state === "completed");
  const answered = (await client.inspect(interrupted.id)).job;
  assert.match(answered.result!, /Engineers/);
  await client.acknowledge(answered.id, answered.attention!.id);

  const effects = join(home, "effects");
  const unsafe = await client.start({ ...input(`shell:printf x >> '${effects}'; sleep 1`), tools: "local" });
  await until(async () => readFile(effects, "utf8").catch(() => ""), value => value === "x");
  await kill("SIGKILL");
  await sleep(1200); // SIGKILL cannot clean up descendants; wait for fixture command to finish.
  await boot();
  await client.resume(unsafe.id);
  const recovered = await until(() => client.inspect(unsafe.id), inspection => inspection.job.state === "completed");
  assert.equal(await readFile(effects, "utf8"), "x", "interrupted unsafe tool must not replay");
  assert.match(recovered.job.result!, /interrupted/i);
  await client.acknowledge(unsafe.id, recovered.job.attention!.id);

  const marker = join(home, "should-not-exist");
  const cancel = await client.start({ ...input(`shell:sleep 2; printf bad > '${marker}'`), tools: "local" });
  await until(() => client.list(), jobs => jobs.some(job => job.id === cancel.id && job.activity === "Tool: bash"));
  assert.equal((await client.cancel(cancel.id)).state, "cancelled");
  await sleep(2200);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  assert.equal((await client.list()).length, 0);
  assert.equal((await client.list({ all: true })).length, 4);
  assert.equal(diagnostic, "");
});

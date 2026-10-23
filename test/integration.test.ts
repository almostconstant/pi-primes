import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "../src/client.js";
import { until } from "./helpers.js";
import type { StartInput } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixture-worker.ts", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx/esm"));

test("concurrent jobs survive parent exit; crash recovery is explicit; unsafe replay and cancellation are isolated", { timeout: 60_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "primes-"));
  const otherProject = join(home, "other-project");
  await mkdir(otherProject);
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
  const input = (goal: string): StartInput => ({ goal, context: "", cwd: home,
    createdBy: { client: "pi", sessionId: "original-parent" }, model: { provider: "fixture", modelId: "fixture" }, thinking: "off", tools: "none" });
  t.after(async () => { if (worker) await kill("SIGTERM"); await rm(home, { recursive: true, force: true }); });
  await boot();

  // Two same-session jobs and another project remain discoverable after parent process exits.
  const parent = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import { Client } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).href)};
    const client = new Client(${JSON.stringify(home)});
    const jobs = await Promise.all([
      client.start(${JSON.stringify(input("slow independent task one"))}),
      client.start(${JSON.stringify(input("slow independent task two"))}),
      client.start(${JSON.stringify({ ...input("slow another project"), cwd: otherProject })}),
    ]);
    if (jobs.some(job => job.state !== "running")) throw Error("Jobs not concurrently admitted");
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let parentError = "";
  parent.stderr.on("data", chunk => { parentError += chunk; });
  assert.equal((await once(parent, "exit"))[0], 0, parentError);
  const page = await until(() => client.list(), page => page.jobs.length === 3 && page.jobs.every(job => job.state === "completed"));
  const first = page.jobs[0]!;
  assert.equal((await client.inspect(first.id, "result")).job.result, "Fixture result");
  assert.equal((await client.list({ cwd: home })).jobs.length, 2);
  assert.equal((await client.list({ cwd: otherProject })).jobs.length, 1);
  assert.deepEqual(first.createdBy, { client: "pi", sessionId: "original-parent" });
  assert.equal((await stat(join(home, "worker.sock"))).mode & 0o777, 0o600);

  const interruptedA = await client.start(input("slow recover one"));
  const interruptedB = await client.start({ ...input("slow recover another project"), cwd: otherProject });
  await kill("SIGKILL");
  await boot();
  assert.equal((await client.inspect(interruptedA.id)).job.state, "interrupted");
  assert.equal((await client.inspect(interruptedB.id)).job.state, "interrupted");
  await sleep(600);
  assert.equal((await client.inspect(interruptedA.id)).job.state, "interrupted", "inspection must not resume scheduler");
  await client.resume(interruptedA.id);
  await until(() => client.inspect(interruptedA.id), inspection => inspection.job.state === "completed");
  assert.equal((await client.inspect(interruptedB.id)).job.state, "interrupted", "resuming one job must not resume sibling");
  await client.cancel(interruptedB.id);
  const transcript = await client.inspect(interruptedA.id, "transcript");
  assert.equal(transcript.entries.filter((entry: any) => entry.kind === "pi.user").length, 1);

  const effects = join(home, "effects");
  const unsafe = await client.start({ ...input(`shell:printf x >> '${effects}'; sleep 1`), tools: "local" });
  await until(async () => readFile(effects, "utf8").catch(() => ""), value => value === "x");
  await kill("SIGKILL");
  await sleep(1200); // SIGKILL cannot clean up descendants; let fixture shell finish.
  await boot();
  await client.resume(unsafe.id);
  const recovered = await until(() => client.inspect(unsafe.id, "result"), inspection => inspection.job.state === "completed");
  assert.equal(await readFile(effects, "utf8"), "x", "unsafe tool must not replay");
  assert.match(recovered.job.result!, /interrupted/i);

  const marker = join(home, "should-not-exist");
  const survivor = await client.start(input("slow survivor"));
  const cancel = await client.start({ ...input(`shell:sleep 2; printf bad > '${marker}'`), tools: "local" });
  await until(() => client.inspect(cancel.id), inspection => inspection.job.activity === "Tool: bash");
  assert.equal((await client.cancel(cancel.id)).state, "cancelled");
  await until(() => client.inspect(survivor.id), inspection => inspection.job.state === "completed");
  await sleep(2200);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  assert.equal((await client.list()).jobs.length, 8);
  assert.equal(diagnostic, "");
});

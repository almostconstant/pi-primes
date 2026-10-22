import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Client } from "../src/client.js";
import { Engine } from "../src/engine.js";
import { JobStore } from "../src/store.js";
import { DurableRuntime } from "../src/runtime.js";
import { serve } from "../src/server.js";
import { fixtureModels, until } from "./helpers.js";
import type { StartInput } from "../src/types.js";

async function setup(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "primes-rpc-"));
  const engine = new Engine(new JobStore(join(home, "jobs")), (directory, job) => DurableRuntime.open(directory, job, fixtureModels()));
  await engine.initialize();
  const service = await serve(engine, home);
  t.after(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });
  const input = (goal: string): StartInput => ({ goal, context: "", cwd: home, tools: "none",
    owner: { sessionId: "parent", sessionFile: null }, model: { provider: "fixture", modelId: "fixture" } });
  return { home, client: new Client(home), input };
}

test("RPC preserves UTF-8 characters split across request chunks", async t => {
  const { home, client, input } = await setup(t);
  for (const character of ["é", "🪨"]) {
    for (let boundary = 1; boundary < Buffer.byteLength(character); boundary++) {
      const goal = `Goal: ${character}`;
      const body = Buffer.from(JSON.stringify({ method: "start", args: [input(goal)] }));
      const split = body.indexOf(Buffer.from(character)) + boundary;
      const response = await new Promise<any>((resolve, reject) => {
        const req = request({ socketPath: join(home, "worker.sock"), path: "/rpc", method: "POST" }, res => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", chunk => { text += chunk; });
          res.on("error", reject);
          res.on("end", () => resolve(JSON.parse(text)));
        });
        req.on("error", reject);
        req.write(body.subarray(0, split));
        void sleep(20).then(() => req.end(body.subarray(split)));
      });
      assert.equal(response.value.goal, goal);
      await client.cancel(response.value.id);
    }
  }
});

test("large image transcript cannot break status/result; transcript preview stays bounded", async t => {
  const { home, client, input } = await setup(t);
  const image = join(home, "large.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/ngAAAAASUVORK5CYII=", "base64");
  await writeFile(image, Buffer.concat([png, Buffer.alloc(3_100_000)]));
  const job = await client.start({ ...input(`read:${image}`), tools: "read" });
  await until(() => client.list(), jobs => jobs.some(candidate => candidate.id === job.id && candidate.state === "completed"));
  const status = await client.inspect(job.id);
  assert.equal(status.job.state, "completed");
  assert.equal(status.job.result, undefined);
  assert.deepEqual(status.entries, []);
  assert.equal(status.live, null);
  assert.equal((await client.inspect(job.id, "result")).job.result, "Read image");
  const transcript = await client.inspect(job.id, "transcript");
  assert.equal(transcript.truncated, true);
  assert.ok(transcript.entries.some((entry: any) => entry.omitted));
  assert.ok(JSON.stringify(transcript).length < 1_500_000);
  assert.equal(transcript.storagePath, join(home, "jobs", job.id, "durable"));
  await assert.rejects(client.inspect(job.id, "invalid" as any), /Invalid inspection detail/);
});

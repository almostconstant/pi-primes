import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "../src/client.js";
import { Engine } from "../src/engine.js";
import { JobStore } from "../src/store.js";
import { serve } from "../src/server.js";
import type { Job } from "../src/types.js";

test("large historical registry is filtered and paginated before RPC transport", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-history-"));
  const empty = join(home, "empty-project");
  await mkdir(empty);
  const jobs: Job[] = Array.from({ length: 2000 }, (_, i) => ({
    id: randomUUID(), goal: "g".repeat(100_000), context: "private", cwd: home,
    createdBy: { client: "pi", sessionId: "old-parent" }, model: { provider: "fixture", modelId: "fixture" },
    thinking: "off", tools: "none", state: "completed", cancelRequested: false, createdAt: i, updatedAt: i,
    activity: "completed", result: "x".repeat(2000), error: null,
  }));
  const store = new JobStore(join(home, "jobs"));
  store.load = async () => jobs;
  const engine = new Engine(store, async () => { throw new Error("Listing must not open runtime"); }, () => {});
  await engine.initialize();
  const service = await serve(engine, home);
  try {
    const client = new Client(home);
    assert.deepEqual(await client.list({ cwd: empty }), { jobs: [], nextOffset: null });
    const first = await client.list({ limit: 100 });
    assert.equal(first.jobs.length, 100);
    assert.equal(first.nextOffset, 100);
    assert.ok(JSON.stringify(first).length < 100_000);
    assert.equal("context" in first.jobs[0]!, false);
    assert.equal("result" in first.jobs[0]!, false);
    const second = await client.list({ offset: first.nextOffset!, limit: 100 });
    assert.equal(first.jobs.some(job => second.jobs.some(other => job.id === other.id)), false);
    assert.equal((await client.list({ offset: 1999 })).nextOffset, null);
    await assert.rejects(client.list({ limit: 101 }), /Invalid page/);
    await assert.rejects(client.list({ offset: -1 }), /Invalid page/);
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});

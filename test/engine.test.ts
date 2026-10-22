import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { JobStore } from "../src/store.js";
import type { Runtime, RuntimeStatus } from "../src/runtime.js";

function runtime(): Runtime {
  return {
    async run() {}, async reply() {}, async cancel() {}, async close() {},
    async status(): Promise<RuntimeStatus> { return { state: "running", activity: "working", question: null, questionId: null, result: null, error: null, blocked: [] }; },
    async inspect() { return { usage: {}, entries: [], blocked: [], live: {} }; },
  };
}
const input = (cwd: string) => ({ goal: "Generic goal", context: "", cwd,
  owner: { sessionId: "parent", sessionFile: null }, model: { provider: "fixture", modelId: "fixture" } });

test("uncommitted initial save does not strand registry; committed corrupt records fail loudly", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-store-"));
  const store = new JobStore(home);
  try {
    const incomplete = store.path(randomUUID());
    await mkdir(incomplete);
    await writeFile(join(incomplete, ".job-interrupted.tmp"), "partial");
    const engine = new Engine(store, async () => runtime());
    await engine.initialize();
    const job = await engine.start(input(home));
    await engine.close();
    assert.deepEqual((await store.load()).map(job => job.id), [job.id]);
    await writeFile(join(store.path(job.id), "job.json"), "broken");
    await assert.rejects(store.load(), SyntaxError);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("interrupted cancellation cannot accidentally resume execution", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-cancel-"));
  const store = new JobStore(home);
  const instance = runtime();
  instance.cancel = async () => { throw new Error("Abort interrupted"); };
  const engine = new Engine(store, async () => instance);
  try {
    await engine.initialize();
    const job = await engine.start(input(home));
    await assert.rejects(engine.cancel(job.id), /Abort interrupted/);
    assert.equal((await store.load())[0]!.cancelRequested, true);
    const recovered = new Engine(store, async () => runtime());
    await recovered.initialize();
    await assert.rejects(recovered.resume(job.id), /Cancellation requested/);
    assert.equal((await recovered.cancel(job.id)).state, "cancelled");
    await recovered.close();
  } finally { await engine.close(); await rm(home, { recursive: true, force: true }); }
});

test("validation rejects bad capabilities and cwd without admitting job", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-validation-"));
  const engine = new Engine(new JobStore(home), async () => runtime());
  try {
    await engine.initialize();
    await assert.rejects(engine.start({ ...input(home), tools: "wrong" as any }), /Invalid tools/);
    await assert.rejects(engine.start({ ...input(home), goal: " " }), /Invalid goal/);
    await assert.rejects(engine.start({ ...input(home), cwd: join(home, "missing") }), /ENOENT/);
    assert.equal((await engine.list({ all: true })).length, 0);
  } finally { await engine.close(); await rm(home, { recursive: true, force: true }); }
});

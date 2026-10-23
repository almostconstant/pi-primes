import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Engine } from "../src/engine.js";
import { JobStore } from "../src/store.js";
import type { Runtime, RuntimeStatus } from "../src/runtime.js";
import type { StartInput } from "../src/types.js";

function runtime(): Runtime {
  return {
    async run() {}, async cancel() {}, async close() {},
    async status(): Promise<RuntimeStatus> { return { state: "running", activity: "working", result: null, error: null, blocked: [] }; },
    async inspect() { return { usage: {}, entries: [], blocked: [], live: null, truncated: false }; },
  };
}
const input = (cwd: string): StartInput => ({ goal: "Generic goal", context: "", cwd,
  createdBy: { client: "pi", sessionId: "parent" }, thinking: "off", model: { provider: "fixture", modelId: "fixture" } });
const validate = () => {};

test("uncommitted initial save is skipped; corrupt and previous-prototype records fail loudly", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-store-"));
  const store = new JobStore(home);
  const engine = new Engine(store, async () => runtime(), validate);
  try {
    const incomplete = store.path(randomUUID());
    await mkdir(incomplete);
    await writeFile(join(incomplete, ".job-interrupted.tmp"), "partial");
    await engine.initialize();
    const job = await engine.start(input(home));
    assert.deepEqual((await store.load()).map(job => job.id), [job.id]);
    await writeFile(join(store.path(job.id), "job.json"), JSON.stringify({ version: 1, job }));
    await assert.rejects(store.load(), /Unsupported or corrupt MVP job record/);
    await writeFile(join(store.path(job.id), "job.json"), "broken");
    await assert.rejects(store.load(), SyntaxError);
  } finally { await engine.close(); await rm(home, { recursive: true, force: true }); }
});

test("same-session and cross-project jobs execute independently; cancel affects only its target", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-concurrent-"));
  const other = join(home, "other");
  await mkdir(other);
  const instances = new Map<string, Runtime & { cancelled: boolean }>();
  const engine = new Engine(new JobStore(join(home, "jobs")), async (_directory, job) => {
    const instance = { ...runtime(), cancelled: false };
    instance.cancel = async () => { instance.cancelled = true; };
    instances.set(job.id, instance);
    return instance;
  }, validate);
  try {
    await engine.initialize();
    const first = await engine.start(input(home));
    const second = await engine.start(input(home));
    const third = await engine.start(input(other));
    assert.equal((await engine.list()).jobs.length, 3);
    assert.equal((await engine.list({ cwd: home })).jobs.length, 2);
    await engine.cancel(first.id);
    assert.equal(instances.get(first.id)!.cancelled, true);
    assert.equal(instances.get(second.id)!.cancelled, false);
    assert.equal(instances.get(third.id)!.cancelled, false);
    assert.equal((await engine.inspect(second.id)).job.state, "running");
    assert.deepEqual((await engine.inspect(second.id)).job.createdBy, input(home).createdBy);
  } finally { await engine.close(); await rm(home, { recursive: true, force: true }); }
});

test("interrupted cancellation cannot resume; retry cancel finishes after worker restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-cancel-"));
  const store = new JobStore(home);
  const instance = runtime();
  instance.cancel = async () => { throw new Error("Abort interrupted"); };
  const engine = new Engine(store, async () => instance, validate);
  const recovered = new Engine(store, async () => runtime(), validate);
  try {
    await engine.initialize();
    const job = await engine.start(input(home));
    await assert.rejects(engine.cancel(job.id), /Abort interrupted/);
    assert.equal((await store.load())[0]!.cancelRequested, true);
    await recovered.initialize();
    await assert.rejects(recovered.resume(job.id), /Cancellation requested/);
    assert.equal((await recovered.cancel(job.id)).state, "cancelled");
  } finally { await engine.close(); await recovered.close(); await rm(home, { recursive: true, force: true }); }
});

test("one runtime failure does not stop another job", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-failure-"));
  let calls = 0;
  const engine = new Engine(new JobStore(home), async () => {
    const instance = runtime();
    if (calls++ === 0) instance.status = async () => { throw new Error("Provider unavailable"); };
    return instance;
  }, validate);
  try {
    await engine.initialize();
    const first = await engine.start(input(home));
    const second = await engine.start(input(home));
    await engine.tick();
    const jobs = (await engine.list()).jobs;
    assert.equal(jobs.find(job => job.id === first.id)!.state, "interrupted");
    assert.equal(jobs.find(job => job.id === second.id)!.state, "running");
  } finally { await engine.close(); await rm(home, { recursive: true, force: true }); }
});

test("result preview is bounded without changing persisted result", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-preview-"));
  const store = new JobStore(home);
  const instance = runtime();
  const output = "x".repeat(150_000);
  instance.status = async () => ({ state: "completed", activity: "completed", result: output, error: null, blocked: [] });
  const engine = new Engine(store, async () => instance, validate);
  try {
    await engine.initialize();
    const job = await engine.start(input(home));
    await engine.tick();
    assert.equal((await engine.inspect(job.id)).job.result, undefined);
    const preview = await engine.inspect(job.id, "result");
    assert.equal(preview.job.result?.length, 100_000);
    assert.equal(preview.truncated, true);
    assert.equal((await store.load())[0]!.result, output);
  } finally { await engine.close(); await rm(home, { recursive: true, force: true }); }
});

test("validation rejects invalid config before admitting or opening execution", async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-validation-"));
  let opens = 0;
  const engine = new Engine(new JobStore(home), async () => { opens++; return runtime(); }, config => {
    if (config.model.modelId === "missing") throw new Error("Unknown model");
  });
  try {
    await engine.initialize();
    await assert.rejects(engine.start({ ...input(home), tools: "wrong" as any }), /Invalid tools/);
    await assert.rejects(engine.start({ ...input(home), thinking: "wrong" as any }), /Invalid thinking/);
    await assert.rejects(engine.start({ ...input(home), goal: " " }), /Invalid goal/);
    await assert.rejects(engine.start({ ...input(home), cwd: join(home, "missing") }), /ENOENT/);
    await assert.rejects(engine.start({ ...input(home), model: { provider: "fixture", modelId: "missing" } }), /Unknown model/);
    assert.equal((await engine.list()).jobs.length, 0);
    assert.equal(opens, 0);
  } finally { await engine.close(); await rm(home, { recursive: true, force: true }); }
});

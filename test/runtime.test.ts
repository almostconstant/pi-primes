import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DurableRuntime, validateModel } from "../src/runtime.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fixtureModels, until } from "./helpers.js";
import type { Job } from "../src/types.js";

function job(goal = "Task"): Job {
  return {
    id: randomUUID(), goal, context: "", cwd: tmpdir(), model: { provider: "fixture", modelId: "fixture" },
    thinking: "off", createdBy: { client: "pi", sessionId: "parent" }, tools: "none", state: "running", createdAt: 1, updatedAt: 1,
    cancelRequested: false, activity: "Starting", result: null, error: null,
  };
}

test("durable storage reuses original submission after reopen without repeating input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-runtime-"));
  const task = job();
  let runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    assert.equal((await until(() => runtime.status(), status => status.state === "completed")).result, "Fixture result");
    await runtime.close();
    runtime = await DurableRuntime.open(dir, task, fixtureModels());
    await runtime.run(task);
    assert.equal((await runtime.status()).state, "completed");
    const inspection = await runtime.inspect("transcript");
    assert.equal(inspection.entries.filter((entry: any) => entry.kind === "pi.user").length, 1);
    assert.ok(inspection.usage);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test("selected thinking effort reaches provider; capabilities expose no parent-question mechanism", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-settings-"));
  const task = { ...job("settings"), thinking: "high" as const, model: { provider: "fixture", modelId: "reasoning-fixture" } };
  const runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    const done = await until(() => runtime.status(), status => status.state === "completed");
    assert.deepEqual(JSON.parse(done.result!), { reasoning: "high", tools: [] });
    const inspection = await runtime.inspect("transcript");
    assert.doesNotMatch(JSON.stringify(inspection), /ask_parent/);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test("read tool preset exposes only read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-tools-"));
  const task = { ...job("settings"), tools: "read" as const };
  const runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    const done = await until(() => runtime.status(), status => status.state === "completed");
    assert.deepEqual(JSON.parse(done.result!), { reasoning: "off", tools: ["read"] });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test("blocked child stops with reason; clarification is a new job, not pending input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-blocked-"));
  const task = job("blocked: missing audience");
  const runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    const done = await until(() => runtime.status(), status => status.state === "completed");
    assert.match(done.result!, /Blocked: missing target audience/);
    assert.deepEqual(done.blocked, []);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test("cancelling recovered paused execution never starts another model request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-recovered-cancel-"));
  const task = job("slow task");
  let calls = 0;
  const models = fixtureModels(() => { calls++; });
  let runtime = await DurableRuntime.open(dir, task, models);
  try {
    await runtime.run(task);
    await until(async () => calls, count => count === 1);
    await runtime.close();
    runtime = await DurableRuntime.open(dir, task, models);
    await runtime.inspect();
    await runtime.cancel();
    assert.equal(calls, 1, "cancel must mark pending tasks before enabling scheduler");
    assert.equal((await runtime.status()).state, "failed");
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test("model validation rejects missing models, unsupported thinking, and missing worker auth", async () => {
  await assert.rejects(validateModel(job(), createModels()), /Selected model unavailable/);
  await assert.rejects(validateModel({ ...job(), thinking: "high" }, fixtureModels()), /unsupported/);
  await assert.rejects(validateModel({ ...job(), model: { provider: "fixture", modelId: "reasoning-fixture" }, thinking: "max" }, fixtureModels()), /unsupported/);
  const models = fixtureModels();
  models.getAvailable = async () => [];
  await assert.rejects(validateModel(job(), models), /worker authentication/);
});

test("missing model prevents execution, not inspection or cancellation; inspection does not schedule", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-model-"));
  const task = job("slow task");
  let runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    await runtime.close();
    runtime = await DurableRuntime.open(dir, task, createModels());
    assert.ok((await runtime.inspect("transcript")).entries.length);
    await assert.rejects(runtime.run(task), /Selected model unavailable/);
    await runtime.cancel();
    assert.equal((await runtime.status()).state, "failed");
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

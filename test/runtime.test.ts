import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DurableRuntime } from "../src/runtime.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fixtureModels, until } from "./helpers.js";
import type { Job } from "../src/types.js";

export function job(goal = "Task"): Job {
  return {
    id: randomUUID(), goal, context: "", input: goal, cwd: tmpdir(), model: { provider: "fixture", modelId: "fixture" },
    owner: { sessionId: "parent", sessionFile: null }, tools: "none", state: "running", createdAt: 1, updatedAt: 1,
    cancelRequested: false, activity: "Starting", question: null, result: null, error: null, attention: null, run: 1,
  };
}

test("real durable storage completes and reuses original submission after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-runtime-"));
  const task = job();
  let runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    const status = await until(() => runtime.status(), status => status.state === "completed");
    assert.equal(status.result, "Fixture result");
    await runtime.close();
    runtime = await DurableRuntime.open(dir, task, fixtureModels());
    await runtime.run(task);
    assert.equal((await runtime.status()).state, "completed");
    const inspection = await runtime.inspect();
    assert.equal(inspection.entries.filter((entry: any) => entry.kind === "pi.user").length, 1);
    assert.ok(inspection.usage);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ask_parent checkpoint survives reopen; inspection does not resume; reply unblocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-question-"));
  const task = job("ask for context");
  let runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    const waiting = await until(() => runtime.status(), status => status.state === "waiting_for_input");
    assert.equal(waiting.question, "Which audience?");
    await runtime.close();
    runtime = await DurableRuntime.open(dir, task, fixtureModels());
    assert.equal((await runtime.status()).state, "waiting_for_input");
    await runtime.inspect();
    await runtime.run(task);
    assert.equal((await runtime.status()).questionId, waiting.questionId);
    await runtime.reply("Engineers");
    const done = await until(() => runtime.status(), status => status.state === "completed");
    assert.match(done.result!, /Engineers/);
    await assert.rejects(runtime.reply("Late reply"), /no pending question/);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test("missing model blocks execution, not inspection or cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "primes-model-"));
  const task = job("ask for context");
  let runtime = await DurableRuntime.open(dir, task, fixtureModels());
  try {
    await runtime.run(task);
    await until(() => runtime.status(), status => status.state === "waiting_for_input");
    await runtime.close();
    runtime = await DurableRuntime.open(dir, task, createModels());
    assert.ok((await runtime.inspect()).entries.length);
    await assert.rejects(runtime.run(task), /Selected model unavailable/);
    await runtime.cancel();
    assert.equal((await runtime.status()).state, "failed");
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

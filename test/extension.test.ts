import assert from "node:assert/strict";
import { test } from "node:test";
import { createExtension } from "../src/extension.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JobClient, JobSummary } from "../src/types.js";

function setup() {
  const job: JobSummary = {
    id: "j1", goal: "Do work", cwd: "/project", createdBy: { client: "pi", sessionId: "parent" },
    model: { provider: "test", modelId: "model" }, thinking: "medium", tools: "none", state: "running",
    cancelRequested: false, createdAt: 1, updatedAt: 1, activity: "working", error: null,
  };
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const starts: unknown[] = [];
  const lists: unknown[] = [];
  const inspections: unknown[] = [];
  const controls: unknown[] = [];
  const notifications: unknown[] = [];
  const events: string[] = [];
  const client: JobClient = {
    async start(input) { starts.push(input); return job; },
    async list(input) { lists.push(input); return { jobs: [job], nextOffset: 50 }; },
    async inspect(id, detail) {
      inspections.push([id, detail]);
      return { job: { ...job, ...(detail === "status" ? {} : { result: "Blocked: missing context" }) },
        recordPath: "/state/job.json", storagePath: "/state/durable", worker: { pid: 1 }, usage: {}, blocked: [],
        entries: detail === "transcript" ? ["full-transcript"] : [], live: null, truncated: false };
    },
    async resume(id) { controls.push(["resume", id]); return job; },
    async cancel(id) { controls.push(["cancel", id]); return job; },
  };
  const ctx: any = {
    cwd: "/project", hasUI: true, model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => "parent" },
    ui: { notify: (...args: unknown[]) => notifications.push(args) },
  };
  const pi = {
    on(name: string) { events.push(name); },
    getThinkingLevel: () => "medium",
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    sendMessage() { throw new Error("MVP must not inject automatic notifications"); },
  };
  createExtension(client)(pi as unknown as ExtensionAPI);
  const execute = (name: string, params: unknown) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  return { job, client, ctx, tools, commands, starts, lists, inspections, controls, notifications, events, execute };
}

test("factory has no polling/worker startup, notification handlers, or old control tools", () => {
  const h = setup();
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.lists, []);
  assert.deepEqual([...h.tools.keys()].sort(), ["durable_cancel", "durable_inspect", "durable_list", "durable_resume", "durable_start"]);
});

test("start captures parent model/thinking and creator; explicit overrides are per job", async () => {
  const h = setup();
  await h.execute("durable_start", { goal: "Goal", context: "Only this" });
  assert.deepEqual(h.starts[0], { goal: "Goal", context: "Only this", tools: "none", cwd: "/project",
    createdBy: { client: "pi", sessionId: "parent" }, model: { provider: "test", modelId: "model" }, thinking: "medium" });
  h.ctx.model = undefined;
  await assert.rejects(h.execute("durable_start", { goal: "Goal", context: "" }), /Select a model/);
  await h.execute("durable_start", { goal: "Other", context: "", tools: "local", model: { provider: "other", modelId: "specific" }, thinking: "off" });
  assert.deepEqual(h.starts[1], { goal: "Other", context: "", tools: "local", cwd: "/project",
    createdBy: { client: "pi", sessionId: "parent" }, model: { provider: "other", modelId: "specific" }, thinking: "off" });
});

test("list filters scope and bounds history before transport", async () => {
  const h = setup();
  await h.execute("durable_list", {});
  await h.execute("durable_list", { allScopes: true, offset: 50, limit: 25 });
  assert.deepEqual(h.lists, [
    { cwd: "/project", offset: undefined, limit: undefined },
    { cwd: undefined, offset: 50, limit: 25 },
  ]);
});

test("large model-facing pages preserve whole rows and a usable cursor without skips", async () => {
  const h = setup();
  const jobs = Array.from({ length: 180 }, (_, i) => ({ ...h.job, id: `job-${i}`, goal: "界".repeat(240), cwd: "/" + "界".repeat(1000) }));
  h.client.list = async input => {
    const offset = input?.offset ?? 0;
    const limit = input?.limit ?? 50;
    return { jobs: jobs.slice(offset, offset + limit), nextOffset: offset + limit < jobs.length ? offset + limit : null };
  };
  let offset = 0;
  const seen: string[] = [];
  while (true) {
    const output = await h.execute("durable_list", { allScopes: true, offset, limit: 100 });
    const content = output.content[0].text;
    assert.ok(Buffer.byteLength(content) <= 40_000);
    const page = JSON.parse(content);
    seen.push(...page.jobs.map((job: JobSummary) => job.id));
    assert.ok(page.jobs.length > 0);
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + page.jobs.length);
    offset = page.nextOffset;
  }
  assert.deepEqual(seen, jobs.map(job => job.id));
});

test("inspect defaults to result; transcript requires explicit request", async () => {
  const h = setup();
  const answer = await h.execute("durable_inspect", { id: "j1" });
  assert.match(answer.content[0].text, /Blocked: missing context/);
  assert.doesNotMatch(answer.content[0].text, /full-transcript/);
  await h.execute("durable_inspect", { id: "j1", detail: "transcript" });
  assert.deepEqual(h.inspections, [["j1", "result"], ["j1", "transcript"]]);
});

test("manual commands show discoverable results without model turn; controls target exact job", async () => {
  const h = setup();
  await h.commands.get("jobs").handler("", h.ctx);
  await h.commands.get("jobs").handler("all 50", h.ctx);
  await h.commands.get("job").handler("j1", h.ctx);
  assert.deepEqual(h.lists, [{ cwd: "/project", offset: 0 }, { cwd: undefined, offset: 50 }]);
  assert.match(JSON.stringify(h.notifications), /Next page: \/jobs/);
  assert.match(JSON.stringify(h.notifications), /Blocked: missing context/);
  await assert.rejects(h.commands.get("job").handler("j1 bogus", h.ctx), /Usage/);
  await assert.rejects(h.commands.get("jobs").handler("bogus", h.ctx), /Usage/);
  await h.execute("durable_cancel", { id: "j1" });
  await h.execute("durable_resume", { id: "j2" });
  assert.deepEqual(h.controls, [["cancel", "j1"], ["resume", "j2"]]);
});

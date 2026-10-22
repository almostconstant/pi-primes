import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createExtension } from "../src/extension.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JobClient, JobSummary } from "../src/types.js";
const settle = async () => { for (let n = 0; n < 20; n++) await setImmediate(); };

async function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "durable-extension-"));
  const file = join(dir, "session.jsonl");
  const owner = { sessionId: "parent", sessionFile: file };
  const job: JobSummary = {
    id: "j1", goal: "Do work", cwd: "/project", owner, model: { provider: "test", modelId: "model" },
    tools: "none", state: "running", cancelRequested: false, createdAt: 1, updatedAt: 1, activity: "working", question: null,
    error: null, attention: null, run: 1,
  };
  let jobs = [job];
  let branch: any[] = [];
  let leaf = "root";
  const events = new Map<string, Function>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const acks: any[] = [];
  const starts: any[] = [];
  const attaches: any[] = [];
  const statuses: any[] = [];
  const listCalls: any[] = [];
  const client = {
    async list(input: unknown) { listCalls.push(input); return jobs; },
    async start(input: unknown) { starts.push(input); return job; },
    async inspect() { return { job }; },
    async reply() { return job; }, async resume() { return job; }, async cancel() { return job; },
    async attach(...args: unknown[]) { attaches.push(args); return job; },
    async acknowledge(...args: unknown[]) { acks.push(args); return job; },
  };
  const ctx: any = {
    cwd: "/project", hasUI: true, model: { provider: "test", id: "model" }, isIdle: () => true,
    sessionManager: { getSessionId: () => owner.sessionId, getSessionFile: () => owner.sessionFile,
      getBranch: () => branch, getLeafId: () => leaf },
    ui: { setStatus: (...args: unknown[]) => statuses.push(args), notify() {} },
  };
  const pi = {
    on(name: string, handler: Function) { events.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
  };
  createExtension(client as unknown as JobClient)(pi as unknown as ExtensionAPI);
  const emit = async (name: string) => { const value = await events.get(name)?.({}, ctx); await settle(); return value; };
  const tick = async () => { t.mock.timers.tick(2_000); await settle(); };
  const execute = (name: string, params: unknown) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  const append = async (durable = true) => {
    const message = sent.at(-1).message;
    const entry = { type: "custom_message", id: `notification-${branch.length}`, parentId: leaf, ...message };
    branch.push(entry); leaf = entry.id;
    if (durable) await writeFile(file, branch.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  };
  const respond = async (durable = true, stopReason = "stop") => {
    const entry = { type: "message", id: `response-${branch.length}`, parentId: leaf,
      message: { role: "assistant", stopReason, content: [{ type: "text", text: "Handled" }] } };
    branch.push(entry); leaf = entry.id;
    if (durable) await writeFile(file, branch.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  };
  t.after(async () => { await emit("session_shutdown"); t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); });
  return { job, owner, client, ctx, sent, acks, starts, attaches, statuses, listCalls, emit, tick, execute, append, respond,
    setJobs(value: JobSummary[]) { jobs = value; }, setBranch(value: any[]) { branch = value; leaf = "other"; } };
}

test("factory has no polling; start captures model/owner and explicit context", async (t) => {
  const h = await setup(t);
  assert.equal(h.listCalls.length, 0);
  await h.execute("durable_start", { goal: "Goal", context: "Only this" });
  assert.deepEqual(h.starts[0], { goal: "Goal", context: "Only this", tools: "none", cwd: "/project",
    owner: h.owner, model: { provider: "test", modelId: "model" } });
  h.ctx.model = undefined;
  await assert.rejects(h.execute("durable_start", { goal: "Goal", context: "" }), /Select a model/);
});

test("inspection keeps context/transcript out unless explicitly requested", async (t) => {
  const h = await setup(t);
  const details: unknown[] = [];
  h.client.inspect = async (_id?: string, detail?: string) => {
    details.push(detail);
    return { job: { ...h.job, ...(detail === "status" ? {} : { result: "Final answer" }) },
      recordPath: "/state/job.json", storagePath: "/state/durable", worker: { pid: 1 }, usage: {}, blocked: [],
      entries: detail === "transcript" ? ["full-transcript"] : [], live: null, truncated: false };
  };
  const status = await h.execute("durable_inspect", { id: "j1" });
  assert.doesNotMatch(status.content[0].text, /private-context|full-transcript|Final answer/);
  const answer = await h.execute("durable_inspect", { id: "j1", detail: "result" });
  assert.match(answer.content[0].text, /Final answer/);
  assert.doesNotMatch(answer.content[0].text, /private-context|full-transcript/);
  const transcript = await h.execute("durable_inspect", { id: "j1", detail: "transcript" });
  assert.match(transcript.content[0].text, /full-transcript/);
  assert.deepEqual(details, ["status", "result", "transcript"]);
});

test("routine polling is status-only and stops on shutdown", async (t) => {
  const h = await setup(t);
  await h.emit("session_start");
  assert.match(h.statuses[0][1], /1 unfinished/);
  assert.equal(h.sent.length, 0);
  await h.emit("session_shutdown");
  const count = h.listCalls.length;
  await h.tick();
  assert.equal(h.listCalls.length, count);
});

test("busy attention stays durable; acknowledgment requires persisted receipt and completed response", async (t) => {
  const h = await setup(t);
  h.job.attention = { id: "e1", kind: "needs_input", message: "Why?".repeat(500), acknowledged: false };
  h.ctx.isIdle = () => false;
  await h.emit("session_start");
  await h.tick();
  assert.equal(h.sent.length, 0);
  h.ctx.isIdle = () => true;
  await h.tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true });
  assert.ok(h.sent[0].message.content.length < 800);
  h.ctx.isIdle = () => false;
  await h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.acks.length, 0);
  await assert.rejects(h.execute("durable_acknowledge", { id: "j1", eventId: "e1" }), /persisted/);
  await h.append(false);
  await h.tick();
  assert.equal(h.acks.length, 0);
  await h.append();
  await h.tick();
  assert.equal(h.acks.length, 0, "receipt alone cannot consume wakeup");
  await h.respond(false);
  await h.tick();
  assert.equal(h.acks.length, 0, "response must also reach disk");
  await h.respond();
  await h.tick();
  assert.deepEqual(h.acks[0], ["j1", "e1"]);
});

test("reconnect wakes saved receipts without completed response; parent failures do not cause retry loops", async (t) => {
  const h = await setup(t);
  h.job.attention = { id: "e1", kind: "needs_input", message: "Need context", acknowledged: false };
  await h.emit("session_start");
  await h.append();
  await h.tick();
  assert.equal(h.acks.length, 0);
  assert.equal(h.sent.length, 1);
  await h.emit("session_shutdown");
  await h.emit("session_start");
  assert.equal(h.sent.length, 2, "saved receipt without response must wake on reconnect");
  await h.append();
  await h.respond(true, "aborted");
  await h.respond(true, "error");
  await h.respond(true, "toolUse");
  await h.tick();
  await h.tick();
  assert.equal(h.acks.length, 0);
  assert.equal(h.sent.length, 2, "no automatic spending loop after failed/aborted wakeup");
  await h.emit("session_start");
  assert.equal(h.sent.length, 3);
  await h.append();
  await h.respond();
  await h.tick();
  assert.deepEqual(h.acks, [["j1", "e1"]]);
});

test("restart deduplicates transcript before retrying failed acknowledgment", async (t) => {
  const h = await setup(t);
  h.job.attention = { id: "e1", kind: "completed", message: "Done", acknowledged: false };
  h.job.state = "completed";
  await h.emit("session_start");
  await h.append();
  await h.respond();
  h.client.acknowledge = async () => { throw new Error("offline"); };
  await h.emit("session_start");
  assert.equal(h.sent.length, 1);
  h.client.acknowledge = async (...args: unknown[]) => { h.acks.push(args); return h.job; };
  await h.tick();
  assert.deepEqual(h.acks, [["j1", "e1"]]);
  assert.equal(h.sent.length, 1);
});

test("foreign owners never wake; idle owner wakes; exact event required", async (t) => {
  const h = await setup(t);
  h.job.owner = { sessionId: "elsewhere", sessionFile: null };
  h.job.attention = { id: "e1", kind: "failed", message: "Failure", acknowledged: false };
  await h.emit("session_start");
  assert.equal(h.sent.length, 0);
  h.job.owner = { ...h.owner };
  await h.tick();
  assert.equal(h.sent[0].options.triggerTurn, true);
  await h.append();
  await h.respond();
  await assert.rejects(h.execute("durable_acknowledge", { id: "j1", eventId: "old" }), /Exact attention/);
  await h.execute("durable_acknowledge", { id: "j1", eventId: "e1" });
  assert.deepEqual(h.acks, [["j1", "e1"]]);
});

test("busy attention cannot be lost by clearQueue and does not block branch navigation", async (t) => {
  const h = await setup(t);
  h.job.attention = { id: "e1", kind: "needs_input", message: "Input", acknowledged: false };
  h.ctx.isIdle = () => false;
  await h.emit("session_start");
  assert.equal(h.sent.length, 0, "no Pi follow-up to clear");
  assert.equal(await h.emit("session_before_tree"), undefined);
  h.setBranch([]);
  await h.emit("session_tree");
  h.ctx.isIdle = () => true;
  await h.tick();
  assert.equal(h.sent.length, 1);
});

test("list scope/history are independent and attach is explicit", async (t) => {
  const h = await setup(t);
  h.setJobs([h.job, { ...h.job, id: "other", cwd: "/elsewhere" }, { ...h.job, id: "old", state: "completed" }]);
  assert.equal((await h.execute("durable_list", {})).details.length, 1);
  assert.equal((await h.execute("durable_list", { allScopes: true })).details.length, 2);
  assert.equal((await h.execute("durable_list", { allHistory: true })).details.length, 2);
  assert.equal((await h.execute("durable_list", { allScopes: true, allHistory: true })).details.length, 3);
  assert.equal(h.attaches.length, 0);
  await h.execute("durable_attach", { id: "other" });
  assert.deepEqual(h.attaches, [["other", h.owner]]);
});

test("switch during list drops stale result; branch change does not reuse abandoned receipt", async (t) => {
  const h = await setup(t);
  h.job.attention = { id: "e1", kind: "completed", message: "Done", acknowledged: false };
  let release!: (jobs: JobSummary[]) => void;
  h.client.list = () => new Promise((resolve) => { release = resolve; });
  await h.emit("session_start");
  await h.emit("session_shutdown");
  h.owner.sessionId = "new-parent";
  release([h.job]);
  await settle();
  assert.equal(h.sent.length, 0);
  h.client.list = async () => [h.job];
  h.job.owner = { ...h.owner };
  await h.emit("session_start");
  await h.append();
  h.setBranch([]);
  await h.emit("session_tree");
  assert.equal(h.sent.length, 2);
  assert.equal(h.acks.length, 0);
});

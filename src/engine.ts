import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { JobStore } from "./store.js";
import { summarize, unfinished, type Attention, type InspectDetail, type Job, type JobClient, type ListInput, type Owner, type StartInput } from "./types.js";
import type { Runtime } from "./runtime.js";

type RuntimeFactory = (directory: string, job: Job) => Promise<Runtime>;
const text = (value: unknown, name: string, max = 100_000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};
function owner(value: Owner): Owner {
  return { sessionId: text(value?.sessionId, "owner session ID", 1000), sessionFile: value?.sessionFile === null ? null : text(value?.sessionFile, "owner session file", 8000) };
}

export class Engine implements JobClient {
  private jobs = new Map<string, Job>();
  private runtime: { id: string; instance: Runtime } | null = null;
  private line: Promise<unknown> = Promise.resolve();
  constructor(private store: JobStore, private openRuntime: RuntimeFactory) {}

  // HTTP calls and monitor ticks share this line; background model/tool execution does not.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.line.then(operation);
    this.line = result.catch(() => undefined);
    return result;
  }
  async initialize() {
    for (const job of await this.store.load()) {
      this.jobs.set(job.id, job);
      if (job.state === "running" || job.state === "waiting_for_input" || (unfinished(job.state) && job.cancelRequested)) {
        await this.update(job, {
          state: "interrupted", activity: "Worker restarted; explicit resume required",
          attention: this.event("interrupted", job.cancelRequested ? "Cancellation interrupted. Use cancel again to finish stopping job; resume is disabled." : "Worker restarted. Inspect partial work, then explicitly resume or cancel."),
        });
      }
    }
  }
  private get(id: string) {
    this.store.path(id);
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job ID");
    return job;
  }
  private event(kind: Attention["kind"], message: string): Attention {
    return { id: randomUUID(), kind, message: message.slice(0, 2000), acknowledged: false };
  }
  private async update(job: Job, change: Partial<Job>) {
    const next = { ...job, ...change, updatedAt: Date.now() };
    await this.store.save(next);
    this.jobs.set(job.id, next);
    return next;
  }
  private async activate(job: Job) {
    if (this.runtime) throw new Error("One job can execute at a time; cancel or finish active job first");
    const runtime = await this.openRuntime(join(this.store.path(job.id), "durable"), job);
    this.runtime = { id: job.id, instance: runtime };
    try { await runtime.run(job); }
    catch (error) { await runtime.close(); this.runtime = null; throw error; }
  }

  start(input: StartInput) { return this.serial(async () => {
    if (this.runtime) throw new Error("One job can execute at a time; cancel or finish active job first");
    const tools = input.tools ?? "none";
    if (!["none", "read", "local"].includes(tools)) throw new Error("Invalid tools; choose none, read, or local");
    const goal = text(input.goal, "goal");
    const suppliedContext = input.context ?? "";
    if (typeof suppliedContext !== "string" || suppliedContext.length > 100_000) throw new Error("Invalid context");
    const cwd = await realpath(text(input.cwd, "cwd", 8000));
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory");
    const id = randomUUID();
    const job: Job = {
      id, goal, context: suppliedContext, cwd, owner: owner(input.owner),
      model: { provider: text(input.model?.provider, "provider", 200), modelId: text(input.model?.modelId, "model ID", 1000) },
      tools, state: "running", cancelRequested: false, createdAt: Date.now(), updatedAt: Date.now(), activity: "Starting",
      question: null, result: null, error: null, attention: null, run: 1,
      input: `${goal}${suppliedContext ? `\n\nProvided context:\n${suppliedContext}` : ""}`,
    };
    await this.store.save(job);
    this.jobs.set(id, job);
    try { await this.activate(job); }
    catch (error) { await this.fail(job, error); }
    return summarize(this.get(id));
  }); }

  list(input: ListInput = {}) { return this.serial(async () => {
    const cwd = input.cwd === undefined ? undefined : await realpath(text(input.cwd, "cwd", 8000));
    if (input.all !== undefined && typeof input.all !== "boolean") throw new Error("Invalid history filter");
    return [...this.jobs.values()]
      .filter(job => (!cwd || job.cwd === cwd) && (input.all || unfinished(job.state) || (job.attention && !job.attention.acknowledged)))
      .sort((a, b) => b.createdAt - a.createdAt).map(summarize);
  }); }

  inspect(id: string, detail: InspectDetail = "status") { return this.serial(async () => {
    if (!["status", "result", "transcript"].includes(detail)) throw new Error("Invalid inspection detail");
    const job = this.get(id);
    const active = this.runtime?.id === id ? this.runtime.instance : null;
    const runtime = active ?? await this.openRuntime(join(this.store.path(id), "durable"), job);
    try {
      const inspection = await runtime.inspect(detail);
      const result = detail === "status" ? {} : { result: job.result?.slice(0, 100_000) ?? null };
      return { recordPath: join(this.store.path(id), "job.json"), storagePath: join(this.store.path(id), "durable"),
        job: { ...summarize(job), ...result }, worker: { pid: process.pid }, ...inspection,
        truncated: inspection.truncated || (detail !== "status" && (job.result?.length ?? 0) > 100_000) };
    }
    finally { if (!active) await runtime.close(); }
  }); }

  reply(id: string, message: string) { return this.serial(async () => {
    const job = this.get(id);
    if (job.state !== "waiting_for_input" || this.runtime?.id !== id) throw new Error("Job is not waiting for input; interrupted jobs must be resumed first");
    await this.runtime.instance.reply(text(message, "reply"));
    return summarize(await this.update(job, { state: "running", question: null, attention: null, activity: "Parent replied" }));
  }); }

  resume(id: string) { return this.serial(async () => {
    const job = this.get(id);
    if (job.cancelRequested) throw new Error("Cancellation requested; use cancel again to finish stopping job");
    if (job.state !== "interrupted") throw new Error("Only interrupted jobs can be resumed");
    if (this.runtime) throw new Error("One job can execute at a time");
    // Request ID is unchanged: recover the admitted input instead of creating another run.
    const next = await this.update(job, { state: "running", attention: null, error: null, activity: "Resuming" });
    try { await this.activate(next); }
    catch (error) { await this.fail(next, error); }
    return summarize(this.get(id));
  }); }

  cancel(id: string) { return this.serial(async () => {
    const job = this.get(id);
    if (!unfinished(job.state)) return summarize(job);
    await this.update(job, { cancelRequested: true, state: "interrupted", activity: "Cancellation requested; stopping", attention: null });
    const active = this.runtime?.id === id ? this.runtime.instance : null;
    const runtime = active ?? await this.openRuntime(join(this.store.path(id), "durable"), job);
    try { await runtime.cancel(); }
    finally { await runtime.close(); if (active) this.runtime = null; }
    return summarize(await this.update(this.get(id), { state: "cancelled", attention: null, question: null, activity: "Cancelled; partial artifacts retained" }));
  }); }

  attach(id: string, nextOwner: Owner) { return this.serial(async () => {
    const job = this.get(id);
    const target = owner(nextOwner);
    const changed = target.sessionId !== job.owner.sessionId || target.sessionFile !== job.owner.sessionFile;
    const attention = changed && job.attention && !job.attention.acknowledged ? this.event(job.attention.kind, job.attention.message) : job.attention;
    return summarize(await this.update(job, { owner: target, attention }));
  }); }
  acknowledge(id: string, eventId: string) { return this.serial(async () => {
    const job = this.get(id);
    if (!job.attention || job.attention.id !== eventId) throw new Error("Attention event changed; inspect current event");
    return summarize(await this.update(job, { attention: { ...job.attention, acknowledged: true } }));
  }); }

  tick() { return this.serial(async () => {
    if (!this.runtime) return;
    const { id, instance } = this.runtime;
    const job = this.get(id);
    try {
      const status = await instance.status();
      const blocked = status.blocked.length > 0;
      const state = blocked ? "interrupted" : status.state;
      const changed = state !== job.state || status.question !== job.question;
      let attention = job.attention;
      if (changed) {
        if (blocked) attention = this.event("interrupted", "Durable task blocked. Inspect details before recovery.");
        else if (state === "waiting_for_input") attention = this.event("needs_input", status.question!);
        else if (state === "completed") attention = this.event("completed", status.result || "Job completed");
        else if (state === "failed") attention = this.event("failed", status.error || "Job failed");
      }
      if (changed || status.activity !== job.activity) {
        await this.update(job, { state, activity: status.activity, question: status.question, result: status.result, error: status.error, attention });
      }
      if (state === "completed" || state === "failed" || state === "interrupted") {
        await instance.close(); this.runtime = null;
      }
    } catch (error) {
      // Runtime/storage failure must not leave a falsely healthy "running" registry entry.
      await instance.close().catch(() => undefined); this.runtime = null;
      await this.fail(this.get(id), error);
    }
  }); }
  private async fail(job: Job, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return this.update(job, { state: "interrupted", error: message, activity: "Worker execution unavailable", attention: this.event("interrupted", message) });
  }
  close() { return this.serial(async () => { await this.runtime?.instance.close(); this.runtime = null; }); }
}

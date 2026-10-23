import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { JobStore } from "./store.js";
import { summarize, thinkingLevels, unfinished, type InspectDetail, type Job, type JobClient, type ListInput, type StartInput } from "./types.js";
import type { Runtime } from "./runtime.js";

type RuntimeFactory = (directory: string, job: Job) => Promise<Runtime>;
const text = (value: unknown, name: string, max = 100_000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};

export class Engine implements JobClient {
  private jobs = new Map<string, Job>();
  private runtimes = new Map<string, Runtime>();
  private line: Promise<unknown> = Promise.resolve();
  constructor(private store: JobStore, private openRuntime: RuntimeFactory,
    private validateModel: (config: Pick<Job, "model" | "thinking">) => void | Promise<void>) {}

  // Serialize registry changes, not background model/tool execution.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.line.then(operation);
    this.line = result.catch(() => undefined);
    return result;
  }
  async initialize() {
    for (const job of await this.store.load()) {
      this.jobs.set(job.id, job);
      if (job.state === "running") {
        await this.update(job, { state: "interrupted", activity: "Worker restarted; inspect then explicitly resume or cancel" });
      }
    }
  }
  private get(id: string) {
    this.store.path(id);
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown job ID");
    return job;
  }
  private async update(job: Job, change: Partial<Job>) {
    const next = { ...job, ...change, updatedAt: Date.now() };
    await this.store.save(next);
    this.jobs.set(job.id, next);
    return next;
  }
  private async activate(job: Job) {
    const runtime = await this.openRuntime(join(this.store.path(job.id), "durable"), job);
    try { await runtime.run(job); this.runtimes.set(job.id, runtime); }
    catch (error) { await runtime.close(); throw error; }
  }

  start(input: StartInput) { return this.serial(async () => {
    const tools = input?.tools ?? "none";
    if (!["none", "read", "local"].includes(tools)) throw new Error("Invalid tools; choose none, read, or local");
    const goal = text(input?.goal, "goal");
    const context = input.context ?? "";
    if (typeof context !== "string" || context.length > 100_000) throw new Error("Invalid context");
    if (!thinkingLevels.includes(input.thinking)) throw new Error("Invalid thinking effort");
    const model = { provider: text(input.model?.provider, "provider", 200), modelId: text(input.model?.modelId, "model ID", 1000) };
    await this.validateModel({ model, thinking: input.thinking });
    if (input.createdBy?.client !== "pi") throw new Error("Invalid creator client");
    const createdBy = { client: "pi" as const, sessionId: text(input.createdBy.sessionId, "creator session ID", 1000) };
    const cwd = await realpath(text(input.cwd, "cwd", 8000));
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory");
    const job: Job = {
      id: randomUUID(), goal, context, cwd, createdBy, model, thinking: input.thinking,
      tools, state: "running", cancelRequested: false, createdAt: Date.now(), updatedAt: Date.now(),
      activity: "Starting", result: null, error: null,
    };
    await this.store.save(job);
    this.jobs.set(job.id, job);
    try { await this.activate(job); }
    catch (error) { await this.fail(job, error); }
    return summarize(this.get(job.id));
  }); }

  list(input: ListInput = {}) { return this.serial(async () => {
    const cwd = input.cwd === undefined ? undefined : await realpath(text(input.cwd, "cwd", 8000));
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page; offset >= 0, limit 1..100");
    const jobs = [...this.jobs.values()].filter(job => !cwd || job.cwd === cwd)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { jobs: jobs.slice(offset, offset + limit).map(summarize), nextOffset: offset + limit < jobs.length ? offset + limit : null };
  }); }

  inspect(id: string, detail: InspectDetail = "status") { return this.serial(async () => {
    if (!["status", "result", "transcript"].includes(detail)) throw new Error("Invalid inspection detail");
    const job = this.get(id);
    const active = this.runtimes.get(id);
    const runtime = active ?? await this.openRuntime(join(this.store.path(id), "durable"), job);
    try {
      const inspection = await runtime.inspect(detail);
      const result = detail === "status" ? {} : { result: job.result?.slice(0, 100_000) ?? null };
      return { recordPath: join(this.store.path(id), "job.json"), storagePath: join(this.store.path(id), "durable"),
        job: { ...summarize(job), ...result }, worker: { pid: process.pid }, ...inspection,
        truncated: inspection.truncated || (detail !== "status" && (job.result?.length ?? 0) > 100_000) };
    } finally { if (!active) await runtime.close(); }
  }); }

  resume(id: string) { return this.serial(async () => {
    const job = this.get(id);
    if (job.cancelRequested) throw new Error("Cancellation requested; use cancel again to finish stopping job");
    if (job.state !== "interrupted") throw new Error("Only interrupted jobs can be resumed");
    await this.validateModel(job);
    const next = await this.update(job, { state: "running", error: null, activity: "Resuming" });
    try { await this.activate(next); }
    catch (error) { await this.fail(next, error); }
    return summarize(this.get(id));
  }); }

  cancel(id: string) { return this.serial(async () => {
    const job = this.get(id);
    if (!unfinished(job.state)) return summarize(job);
    await this.update(job, { cancelRequested: true, state: "interrupted", activity: "Cancellation requested; stopping" });
    const active = this.runtimes.get(id);
    const runtime = active ?? await this.openRuntime(join(this.store.path(id), "durable"), job);
    try { await runtime.cancel(); }
    finally { this.runtimes.delete(id); await runtime.close(); }
    return summarize(await this.update(this.get(id), { state: "cancelled", activity: "Cancelled; partial artifacts retained" }));
  }); }

  tick() { return this.serial(async () => {
    for (const [id, instance] of this.runtimes) {
      let status;
      try { status = await instance.status(); }
      catch (error) {
        this.runtimes.delete(id);
        await instance.close().catch(() => undefined);
        await this.fail(this.get(id), error);
        continue;
      }
      const state = status.blocked.length ? "interrupted" : status.state;
      const job = this.get(id);
      if (state !== job.state || status.activity !== job.activity) {
        await this.update(job, { state, activity: status.activity, result: status.result, error: status.error });
      }
      if (state !== "running") {
        this.runtimes.delete(id);
        await instance.close();
      }
    }
  }); }
  private async fail(job: Job, error: unknown) {
    return this.update(job, { state: "interrupted", error: error instanceof Error ? error.message : String(error), activity: "Execution unavailable; inspect before resume" });
  }
  close() { return this.serial(async () => {
    const results = await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.close()));
    this.runtimes.clear();
    const errors = results.filter(result => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Could not close all runtimes");
  }); }
}

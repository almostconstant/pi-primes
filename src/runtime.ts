import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry, Harness, LiveDoc, UsageDoc, createRegistry, defineExtension,
  section, type Conversation, type Submission, type Storage,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools, createReadTool } from "@earendil-works/pi-durable/tools";
import type { InspectDetail, Job } from "./types.js";

export async function validateModel(config: Pick<Job, "model" | "thinking">, models: Models) {
  const model = models.getModel(config.model.provider, config.model.modelId);
  if (!model) throw new Error("Selected model unavailable in standalone worker; extension-only providers are not inherited");
  if (!getSupportedThinkingLevels(model).includes(config.thinking)) throw new Error(`Thinking effort ${config.thinking} is unsupported by selected model`);
  if (!(await models.getAvailable(config.model.provider)).some(candidate => candidate.id === model.id)) throw new Error("Selected model has no available worker authentication");
}
export type RuntimeStatus = {
  state: "running" | "completed" | "failed";
  activity: string;
  result: string | null;
  error: string | null;
  blocked: unknown[];
};
export interface Runtime {
  run(job: Job): Promise<void>;
  status(): Promise<RuntimeStatus>;
  cancel(): Promise<void>;
  inspect(detail?: InspectDetail): Promise<{ usage: unknown; entries: unknown[]; blocked: unknown[]; live: unknown; truncated: boolean }>;
  close(): Promise<void>;
}

export class DurableRuntime implements Runtime {
  private constructor(private harness: Harness, private root: Conversation, private models: Models, private submission?: Submission) {}

  static async open(directory: string, job: Job, models: Models, storage?: Storage): Promise<DurableRuntime> {
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "primes",
      sections: [section("role", () => "You are an independent agent completing a delegated goal. Only claim success with evidence. If essential context, authority, or a decision is missing, stop and explain the blocker and what clarification is needed. Do not guess, wait for replies, or repeatedly retry blocked actions. No other agents are available. Final response: outcome or blocker, evidence, remaining limits, and artifact paths.")],
    }));
    if (job.tools === "read") registry.install({ name: "files", tools: [createReadTool()] });
    if (job.tools === "local") {
      const tools = createCodingTools();
      // Interrupted external effects need reconciliation, never automatic replay.
      registry.install({ ...tools, tools: tools.tools?.map(tool => ({ ...tool, replay: tool.name === "read" ? "safe" : "unsafe" })) });
    }
    const environment = new NodeExecutionEnv({ cwd: job.cwd });
    const harness = await Harness.open(storage ?? await openNodeJsonlStorage(directory, context, { fsync: true }), {
      models, registry,
      settings: { toolExecution: "sequential", retry: { maxRetries: 2 } },
      env: () => environment,
      onReport: (error, info) => console.error(info.type, error),
    }, context);
    try {
      const root = await harness.root(context, { agent: { model: job.model, thinkingLevel: job.thinking, cwd: job.cwd } });
      const runtime = new DurableRuntime(harness, root, models);
      const close = runtime.close.bind(runtime);
      runtime.close = async () => {
        try { await close(); } finally { await environment.cleanup(context); }
      };
      // Read-only lookup: inspection must not enable recovered task scheduling.
      const existing = await harness.commit(tx => tx.submissionByRequest(root.id, job.id), context);
      if (existing) runtime.submission = await harness.submission(existing.id, context);
      return runtime;
    } catch (error) {
      try { await harness.close(context); } finally { await environment.cleanup(context); }
      throw error;
    }
  }

  async run(job: Job) {
    await validateModel(job, this.models);
    const inspection = await this.harness.inspect(context);
    for (const task of inspection.tasks) {
      if (task.state.kind === "blocked" && task.state.reason === "restart_limit") await this.harness.retryTask(task.record.id, context);
    }
    this.submission = await this.root.submit({ type: "input", content: `${job.goal}${job.context ? `\n\nProvided context:\n${job.context}` : ""}`, requestId: job.id }, context);
    this.harness.resume();
  }

  async status(): Promise<RuntimeStatus> {
    const live = await this.harness.snapshot(LiveDoc, this.root.id, context);
    const inspection = await this.harness.inspect(context);
    const blocked = inspection.tasks.filter(task => task.state.kind === "blocked");
    const submission = await this.submission?.status(context);
    let result: string | null = null;
    let error: string | null = null;
    let state: RuntimeStatus["state"] = "running";
    if (submission?.status === "done" && submission.type === "input") {
      const entry = await this.harness.commit(tx => tx.entry(AssistantEntry, submission.answer), context);
      result = (entry?.model ?? []).flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "text").map(part => part.text) : []).join("\n");
      state = "completed";
    } else if (submission?.status === "unanswered") {
      state = "failed";
      error = `${submission.reason}${submission.detail ? `: ${JSON.stringify(submission.detail)}` : ""}`;
    }
    const activeTool = live?.tools?.find(tool => tool.status !== "done");
    const activity = blocked.length ? "Execution blocked; inspect task details" : activeTool ? `Tool: ${activeTool.name}` : live?.generation?.retry ? "Retry backoff" : state === "running" ? "Model working" : state;
    return { state, activity, result, error, blocked };
  }

  async cancel() {
    // Mark recovered tasks before abort() implicitly enables their paused scheduler.
    const inspection = await this.harness.inspect(context);
    if (inspection.scheduling === "paused") {
      await Promise.all(inspection.tasks.map(task => this.harness.abortTask(task.record.id, context)));
    }
    await this.root.abort(context, { background: true });
  }
  async inspect(detail: InspectDetail = "status") {
    const usage = await this.harness.snapshot(UsageDoc, this.root.id, context);
    const inspection = await this.harness.inspect(context);
    const blocked = inspection.tasks.filter(task => task.state.kind === "blocked")
      .map(task => ({ id: task.record.id, kind: task.record.kind, state: task.state }));
    let entries: unknown[] = [];
    let live: unknown = null;
    let truncated = false;
    if (detail === "transcript") {
      const page = await this.root.entries({}, 20, undefined, context);
      truncated = page.next !== undefined;
      entries = page.items.map(entry => {
        if (JSON.stringify(entry).length <= 50_000) return entry;
        truncated = true;
        return { id: entry.id, kind: entry.kind, omitted: "Entry exceeds preview limit; read storagePath for full transcript" };
      });
      const snapshot = await this.harness.snapshot(LiveDoc, this.root.id, context);
      if (JSON.stringify(snapshot ?? null).length <= 50_000) live = snapshot;
      else { truncated = true; live = { omitted: "Live state exceeds preview limit" }; }
    }
    return { usage, entries, blocked, live, truncated };
  }
  async close() { await this.harness.close(context); }
}

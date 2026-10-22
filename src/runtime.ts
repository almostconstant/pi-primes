import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry, Harness, LiveDoc, UsageDoc, createRegistry, defineDoc, defineExtension,
  defineTool, section, type Conversation, type Submission, type Storage,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools, createReadTool } from "@earendil-works/pi-durable/tools";
import type { Job } from "./types.js";

// Task IDs make repeated executions of ask_parent reuse the same question and answer.
const Questions = defineDoc({
  kind: "primes.questions", scope: "session", version: 1,
  initial: (): { items: Record<string, { question: string; answer: string | null }> } => ({ items: {} }),
  checkpointWhen: () => true,
});

export type RuntimeStatus = {
  state: "running" | "waiting_for_input" | "completed" | "failed";
  activity: string;
  question: string | null;
  questionId: string | null;
  result: string | null;
  error: string | null;
  blocked: unknown[];
};
export interface Runtime {
  run(job: Job): Promise<void>;
  status(): Promise<RuntimeStatus>;
  reply(message: string): Promise<void>;
  cancel(): Promise<void>;
  inspect(): Promise<{ usage: unknown; entries: unknown[]; blocked: unknown[]; live: unknown }>;
  close(): Promise<void>;
}

export class DurableRuntime implements Runtime {
  private constructor(private harness: Harness, private root: Conversation, private models: Models, private submission?: Submission) {}

  static async open(directory: string, job: Job, models: Models, storage?: Storage): Promise<DurableRuntime> {
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "primes",
      sections: [section("role", () => "You are an independent agent completing a delegated goal. Plan and adapt as needed. Only claim completion when finished. If essential context, authority, or a decision is missing, call ask_parent and wait. Do not guess or repeatedly retry a blocked action. No other agents are available. Final response: outcome, evidence, remaining limits, and any artifact paths.")],
      tools: [defineTool({
        name: "ask_parent",
        description: "Pause until parent provides missing context, permission, or a decision. Use only when unable to proceed safely.",
        parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 8000 }) }),
        replay: "safe", executionMode: "sequential",
        async execute(args, api, invocation) {
          const key = String(api.taskId);
          await api.commit(async tx => {
            const doc = await tx.doc(Questions);
            if (!doc.items[key]) doc.items[key] = { question: args.question, answer: null };
          }, invocation);
          while (true) {
            const item = (await api.snapshot(Questions, invocation))!.items[key]!;
            if (item.answer !== null) return { output: [{ type: "text", text: item.answer }] };
            await sleep(200, undefined, { signal: invocation.abortSignal });
          }
        },
      })],
    }));
    if (job.tools === "read") registry.install({ name: "files", tools: [createReadTool()] });
    if (job.tools === "local") {
      const tools = createCodingTools();
      // Never replay an interrupted filesystem mutation or arbitrary command automatically.
      registry.install({ ...tools, tools: tools.tools?.map(tool => ({ ...tool, replay: tool.name === "read" ? "safe" : "unsafe" })) });
    }
    const environment = new NodeExecutionEnv({ cwd: job.cwd });
    const harness = await Harness.open(storage ?? await openNodeJsonlStorage(directory, context, { fsync: true }), {
      models, registry,
      settings: { toolExecution: "sequential", retry: { maxRetries: 2 } },
      env: () => environment,
      onReport: (error, info) => console.error(info.type, error),
    }, context);
    const root = await harness.root(context, { agent: { model: job.model, cwd: job.cwd } });
    const runtime = new DurableRuntime(harness, root, models);
    const close = runtime.close.bind(runtime);
    runtime.close = async () => {
      await close();
      await environment.cleanup(context);
    };
    // Lookup is read-only: inspecting recovered work must never enable scheduling.
    const existing = await harness.commit(tx => tx.submissionByRequest(root.id, `${job.id}:${job.run}`), context);
    if (existing) runtime.submission = await harness.submission(existing.id, context);
    return runtime;
  }

  async run(job: Job) {
    if (!this.models.getModel(job.model.provider, job.model.modelId)) throw new Error("Selected model unavailable in standalone worker; extension-only providers are not inherited");
    const inspection = await this.harness.inspect(context);
    for (const task of inspection.tasks) {
      if (task.state.kind === "blocked" && task.state.reason === "restart_limit") await this.harness.retryTask(task.record.id, context);
    }
    this.submission = await this.root.submit({ type: "input", content: job.input, requestId: `${job.id}:${job.run}` }, context);
    this.harness.resume();
  }

  async status(): Promise<RuntimeStatus> {
    const questions = await this.harness.snapshot(Questions, context);
    const pending = Object.entries(questions?.items ?? {}).find(([, q]) => q.answer === null);
    const live = await this.harness.snapshot(LiveDoc, this.root.id, context);
    const inspection = await this.harness.inspect(context);
    const blocked = inspection.tasks.filter(task => task.state.kind === "blocked");
    const submission = await this.submission?.status(context);
    let result: string | null = null;
    let error: string | null = null;
    let state: RuntimeStatus["state"] = pending ? "waiting_for_input" : "running";
    if (submission?.status === "done" && submission.type === "input") {
      const entry = await this.harness.commit(tx => tx.entry(AssistantEntry, submission.answer), context);
      result = (entry?.model ?? []).flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "text").map(part => part.text) : []).join("\n");
      state = "completed";
    } else if (submission?.status === "unanswered") {
      state = "failed";
      error = `${submission.reason}${submission.detail ? `: ${JSON.stringify(submission.detail)}` : ""}`;
    }
    const activeTool = live?.tools?.find(tool => tool.status !== "done");
    const activity = blocked.length ? "Execution blocked; inspect task details" : pending ? "Waiting for parent input" : activeTool ? `Tool: ${activeTool.name}` : live?.generation?.retry ? "Retry backoff" : state === "running" ? "Model working" : state;
    return { state, activity, question: pending?.[1].question ?? null, questionId: pending?.[0] ?? null, result, error, blocked };
  }

  async reply(message: string) {
    await this.harness.commit(async tx => {
      const doc = await tx.doc(Questions);
      const pending = Object.values(doc.items).find(item => item.answer === null);
      if (!pending) throw new Error("Job has no pending question");
      pending.answer = message;
    }, context);
  }

  async cancel() { await this.root.abort(context, { background: true }); }
  async inspect() {
    const entries = (await this.root.entries({}, 20, undefined, context)).items;
    const usage = await this.harness.snapshot(UsageDoc, this.root.id, context);
    const { blocked } = await this.status();
    const live = await this.harness.snapshot(LiveDoc, this.root.id, context);
    return { usage, entries: [...entries], blocked, live };
  }
  async close() { await this.harness.close(context); }
}

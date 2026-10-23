import { resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { createClient } from "./client.js";
import { thinkingLevels, type JobClient, type JobPage } from "./types.js";

const compact = (text: string, limit: number) => text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const result = (details: unknown, recordPath?: string, storagePath?: string, previewTruncated = false) => {
  const output = truncateHead(JSON.stringify(details, null, 2));
  return {
    content: [{ type: "text" as const, text: output.content + (output.truncated || previewTruncated ? `\n[Truncated. ${recordPath ? `Full job/result: ${recordPath}; transcript: ${storagePath}` : "Use nextOffset or inspect individual jobs."}]` : "") }],
    details,
  };
};

function listResult(page: JobPage, offset: number) {
  const details = { jobs: page.jobs.map(job => ({ id: job.id, state: job.state, goal: compact(job.goal, 120), cwd: compact(job.cwd, 160) })), nextOffset: page.nextOffset };
  // Fit whole rows and cursor inside Pi's tool-output bound; never skip invisible jobs.
  while (Buffer.byteLength(JSON.stringify(details, null, 2)) > 40_000) {
    details.jobs.pop();
    details.nextOffset = offset + details.jobs.length;
  }
  return result(details);
}

export function createExtension(client: JobClient) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "durable_start", label: "Start durable job",
      description: "Start an independent concurrent job. Supply goal/context explicitly; no parent history or instructions inherited. Defaults to parent's model and thinking effort. Select none/read/local tools; local grants user-level file/shell access, not a sandbox. A blocked child stops with its reason; clarification needs a new job.",
      parameters: Type.Object({
        goal: Type.String({ minLength: 1, maxLength: 100_000 }),
        context: Type.String({ maxLength: 100_000 }),
        tools: Type.Optional(StringEnum(["none", "read", "local"] as const)),
        model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) })),
        thinking: Type.Optional(StringEnum(thinkingLevels)),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        const model = params.model ?? (ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined);
        if (!model) throw new Error("Select a model or specify one for this job.");
        return result(await client.start({ ...params, tools: params.tools ?? "none", model,
          thinking: params.thinking ?? pi.getThinkingLevel(), cwd: ctx.cwd,
          createdBy: { client: "pi", sessionId: ctx.sessionManager.getSessionId() } }));
      },
    });
    pi.registerTool({
      name: "durable_list", label: "List durable jobs",
      description: "List saved jobs in current project, including outcomes. allScopes includes other projects. Pages contain at most 100 jobs; pass nextOffset to fetch another page. Listing never resumes execution.",
      parameters: Type.Object({
        allScopes: Type.Optional(Type.Boolean()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        return listResult(await client.list({ cwd: params.allScopes ? undefined : ctx.cwd, offset: params.offset, limit: params.limit }), params.offset ?? 0);
      },
    });
    pi.registerTool({
      name: "durable_inspect", label: "Inspect durable job",
      description: "Read job outcome, error/blocker and artifact paths. Default result preview; status excludes result; transcript explicitly fetches bounded recent history. Never resumes work.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), detail: Type.Optional(StringEnum(["status", "result", "transcript"] as const)) }),
      async execute(_id, params) {
        const inspection = await client.inspect(params.id, params.detail ?? "result");
        return result(inspection, inspection.recordPath, inspection.storagePath, inspection.truncated);
      },
    });
    for (const action of ["resume", "cancel"] as const) {
      pi.registerTool({
        name: `durable_${action}`, label: `${action} durable job`,
        description: action === "resume" ? "Explicitly resume interrupted durable execution. Reconcile uncertain external effects first; never use this to extend a completed job." : "Cancel one job, stop its active tools, retain history and partial artifacts. Other jobs continue.",
        parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
        async execute(_id, params) { return result(await client[action](params.id)); },
      });
    }
    pi.registerCommand("jobs", {
      description: "List saved project jobs; /jobs all includes all projects. Optional numeric page offset.",
      handler: async (args, ctx) => {
        if (!ctx.hasUI) throw new Error("/jobs requires UI; use durable_list or recovery CLI.");
        const match = /^(all)?(?:\s*(\d+))?$/.exec(args.trim());
        if (!match) throw new Error("Usage: /jobs [all] [offset]");
        const sessionId = ctx.sessionManager.getSessionId();
        const page = await client.list({ cwd: match[1] ? undefined : resolve(ctx.cwd), offset: Number(match[2] ?? 0) });
        if (sessionId !== ctx.sessionManager.getSessionId()) return;
        const lines = page.jobs.map(job => `${job.id} [${job.state}] ${compact(job.goal, 120)}`);
        if (page.nextOffset !== null) lines.push(`Next page: /jobs ${match[1] ? "all " : ""}${page.nextOffset}`);
        ctx.ui.notify(lines.join("\n") || "No jobs.", "info");
      },
    });
    pi.registerCommand("job", {
      description: "Inspect saved outcome: /job <id> [status|result|transcript]. No automatic model turn.",
      handler: async (args, ctx) => {
        if (!ctx.hasUI) throw new Error("/job requires UI; use durable_inspect or recovery CLI.");
        const [id, detail = "result", ...extra] = args.trim().split(/\s+/);
        if (!id || extra.length || !["status", "result", "transcript"].includes(detail)) throw new Error("Usage: /job <id> [status|result|transcript]");
        const sessionId = ctx.sessionManager.getSessionId();
        const inspection = await client.inspect(id, detail as "status" | "result" | "transcript");
        if (sessionId !== ctx.sessionManager.getSessionId()) return;
        const preview = JSON.stringify(inspection, null, 2);
        ctx.ui.notify(preview.slice(0, 4000) + (preview.length > 4000 || inspection.truncated ? `\n[Truncated. Full job/result: ${inspection.recordPath}; transcript: ${inspection.storagePath}]` : ""), "info");
      },
    });
  };
}

export default function extension(pi: ExtensionAPI) {
  createExtension(createClient())(pi);
}

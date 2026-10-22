import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { createClient } from "./client.js";
import { unfinished, type JobClient, type JobSummary, type Owner } from "./types.js";

const messageType = "durable-job-attention";
const compact = (text: string, limit: number) => {
  const line = text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};
const ownerOf = (ctx: ExtensionContext): Owner => ({
  sessionId: ctx.sessionManager.getSessionId(),
  sessionFile: ctx.sessionManager.getSessionFile() ?? null,
});
const sameOwner = (a: Owner, b: Owner) => a.sessionId === b.sessionId && a.sessionFile === b.sessionFile;
const relevant = (job: JobSummary) => unfinished(job.state) || !!(job.attention && !job.attention.acknowledged);

function recorded(ctx: ExtensionContext, jobId: string, eventId: string) {
  return ctx.sessionManager.getBranch().find((entry) => {
    if (entry.type !== "custom_message" || entry.customType !== messageType) return false;
    const details = entry.details as { jobId?: string; eventId?: string; owner?: Owner } | undefined;
    return details?.jobId === jobId && details.eventId === eventId &&
      !!details.owner && sameOwner(details.owner, ownerOf(ctx));
  });
}

function responded(ctx: ExtensionContext, jobId: string, eventId: string) {
  const receipt = recorded(ctx, jobId, eventId);
  if (!receipt) return undefined;
  const branch = ctx.sessionManager.getBranch();
  return branch.slice(branch.findIndex(entry => entry.id === receipt.id) + 1).find(entry =>
    entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop");
}

// A saved receipt alone cannot prove the parent finished its wakeup turn.
async function persisted(ctx: ExtensionContext, jobId: string, eventId: string) {
  const entry = recorded(ctx, jobId, eventId);
  const response = responded(ctx, jobId, eventId);
  const file = ctx.sessionManager.getSessionFile();
  if (!entry || !response || !file) return false;
  try {
    const lines = (await readFile(file, "utf8")).split("\n");
    let receiptSaved = false;
    let responseSaved = false;
    for (const line of lines) {
      try {
        const disk = JSON.parse(line);
        receiptSaved ||= disk.id === entry.id && disk.type === "custom_message" &&
          disk.customType === messageType && disk.details?.jobId === jobId && disk.details?.eventId === eventId;
        responseSaved ||= disk.id === response.id && disk.type === "message" &&
          disk.message?.role === "assistant" && disk.message.stopReason === "stop";
      } catch { /* Incomplete trailing lines do not confirm persistence. */ }
    }
    return receiptSaved && responseSaved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const result = (details: unknown, recordPath?: string, storagePath?: string, previewTruncated = false) => {
  const output = truncateHead(JSON.stringify(details, null, 2));
  return {
    content: [{ type: "text" as const, text: output.content + (output.truncated || previewTruncated ? `\n[Truncated. ${recordPath ? `Full job/result: ${recordPath}${storagePath ? `; transcript storage: ${storagePath}` : ""}` : "Inspect individual jobs for more."}]` : "") }],
    details,
  };
};

export function createExtension(client: JobClient) {
  return (pi: ExtensionAPI) => {
    let active: {
      ctx: ExtensionContext;
      owner: Owner;
      timer?: ReturnType<typeof setTimeout>;
      woken: Set<string>;
    } | undefined;

    const stop = () => {
      if (active?.timer) clearTimeout(active.timer);
      active = undefined;
    };
    const current = (state: NonNullable<typeof active>) => active === state && sameOwner(state.owner, ownerOf(state.ctx));

    async function poll(state: NonNullable<typeof active>) {
      const { ctx } = state;
      const leaf = ctx.sessionManager.getLeafId();
      try {
        // Include terminal attention; never adopt jobs merely because cwd matches.
        const jobs = await client.list();
        if (!current(state) || leaf !== ctx.sessionManager.getLeafId()) return;
        const local = jobs.filter((job) => job.cwd === ctx.cwd && relevant(job));
        if (ctx.hasUI) ctx.ui.setStatus("durable-jobs", `Jobs: ${local.filter((j) => unfinished(j.state)).length} unfinished · ${local.filter((j) => j.attention && !j.attention.acknowledged).length} unacked`);
        for (const job of jobs) {
          if (!current(state)) return;
          const attention = job.attention;
          if (!sameOwner(job.owner, state.owner) || !attention || attention.acknowledged) continue;
          if (await persisted(ctx, job.id, attention.id)) {
            if (!current(state) || !responded(ctx, job.id, attention.id)) return;
            await client.acknowledge(job.id, attention.id);
          } else if (current(state) && leaf === ctx.sessionManager.getLeafId() && ctx.isIdle() &&
            !responded(ctx, job.id, attention.id) && !state.woken.has(attention.id)) {
            // Keep busy-parent events in durable registry, not Pi's clearable follow-up queue.
            pi.sendMessage({
              customType: messageType,
              display: true,
              content: `Durable job ${job.id}: ${attention.kind}\nGoal: ${compact(job.goal, 180)}\nReason: ${compact(attention.message, 300)}${job.question ? `\nQuestion: ${compact(job.question, 300)}` : ""}\nUse durable_inspect; request detail=result or transcript only when needed.`,
              details: { jobId: job.id, eventId: attention.id, owner: state.owner },
            }, { triggerTurn: true });
            // One wake attempt per lifecycle avoids retry loops after parent abort/error.
            state.woken.add(attention.id);
          }
        }
      } catch (error) {
        if (current(state) && ctx.hasUI) ctx.ui.setStatus("durable-jobs", `Jobs: ${compact(String(error), 160)}`);
      } finally {
        if (current(state)) {
          state.timer = setTimeout(() => { void poll(state); }, 2_000);
          state.timer.unref?.();
        }
      }
    }

    const start = (ctx: ExtensionContext) => {
      stop();
      const state = { ctx, owner: ownerOf(ctx), woken: new Set<string>() };
      active = state;
      void poll(state);
    };
    pi.on("session_start", (_event, ctx) => start(ctx));
    pi.on("session_shutdown", (_event, ctx) => {
      stop();
      if (ctx.hasUI) ctx.ui.setStatus("durable-jobs", undefined);
    });
    pi.on("session_tree", (_event, ctx) => start(ctx));

    pi.registerTool({
      name: "durable_start", label: "Start durable job",
      description: "Start one independent durable agent. Supply explicit goal and context; parent transcript is never copied. No recursive delegation. Tools default to none; read is read-only, local permits local file/shell work.",
      parameters: Type.Object({
        goal: Type.String({ minLength: 1 }),
        context: Type.String({ description: "Explicit task context only; use empty string if unnecessary." }),
        tools: Type.Optional(StringEnum(["none", "read", "local"] as const)),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        if (!ctx.model) throw new Error("Select a model before starting a durable job.");
        if (!params.goal.trim()) throw new Error("Goal must not be blank.");
        return result(await client.start({ ...params, tools: params.tools ?? "none", cwd: ctx.cwd,
          owner: ownerOf(ctx), model: { provider: ctx.model.provider, modelId: ctx.model.id } }));
      },
    });
    pi.registerTool({
      name: "durable_list", label: "List durable jobs",
      description: "List unfinished or unacknowledged jobs in current cwd. allScopes explicitly includes other directories; allHistory explicitly includes acknowledged terminal jobs. Listing never attaches jobs.",
      parameters: Type.Object({
        cwd: Type.Optional(Type.String()),
        allScopes: Type.Optional(Type.Boolean()),
        allHistory: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        const cwd = resolve(ctx.cwd, params.cwd ?? ".");
        return result((await client.list({ all: true })).filter((job) =>
          (params.allScopes === true || job.cwd === cwd) && (params.allHistory === true || relevant(job))));
      },
    });
    pi.registerTool({
      name: "durable_inspect", label: "Inspect durable job", description: "Check compact status and usage. Request result or transcript explicitly; large output includes full job record path.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), detail: Type.Optional(StringEnum(["status", "result", "transcript"] as const)) }),
      async execute(_id, params) {
        const inspection = await client.inspect(params.id, params.detail ?? "status");
        return result(inspection, inspection.recordPath, inspection.storagePath, inspection.truncated);
      },
    });
    pi.registerTool({
      name: "durable_reply", label: "Reply to durable job", description: "Send explicit input to a waiting durable job.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
      async execute(_id, params) { return result(await client.reply(params.id, params.message)); },
    });
    for (const action of ["resume", "cancel", "attach"] as const) {
      pi.registerTool({
        name: `durable_${action}`, label: `${action} durable job`,
        description: action === "attach" ? "Explicitly transfer job ownership and future attention to this session." : `${action} a durable job by ID.`,
        parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
        async execute(_id, params, _signal, _update, ctx) {
          return result(action === "attach" ? await client.attach(params.id, ownerOf(ctx)) : await client[action](params.id));
        },
      });
    }
    pi.registerTool({
      name: "durable_acknowledge", label: "Acknowledge durable attention",
      description: "Acknowledge exact attention event ID, only after its notification and a completed parent response are persisted in this owning session's active branch. Does not reply or resume.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), eventId: Type.String({ minLength: 1 }) }),
      async execute(_id, params, _signal, _update, ctx) {
        const owner = ownerOf(ctx);
        const { job } = await client.inspect(params.id);
        if (!sameOwner(owner, ownerOf(ctx)) || !sameOwner(job.owner, owner) || job.attention?.id !== params.eventId ||
          !(await persisted(ctx, params.id, params.eventId)) || !sameOwner(owner, ownerOf(ctx)) || !responded(ctx, params.id, params.eventId)) {
          throw new Error("Exact attention notification and completed parent response must be persisted in the owning session's active branch before acknowledgment.");
        }
        return result(await client.acknowledge(params.id, params.eventId));
      },
    });
    pi.registerCommand("durable-jobs", {
      description: "Show cwd jobs; /durable-jobs attach <id> explicitly adopts a job. Use all or history to widen inventory.",
      handler: async (args, ctx) => {
        if (!ctx.hasUI) throw new Error("/durable-jobs requires UI; use durable_list instead.");
        const owner = ownerOf(ctx);
        const lifecycle = active;
        const stillHere = () => active === lifecycle && sameOwner(owner, ownerOf(ctx));
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts[0] === "attach" && parts.length === 2) {
          await client.attach(parts[1]!, owner);
          if (stillHere()) ctx.ui.notify(`Attached ${parts[1]}`, "info");
          return;
        }
        if (parts.some((part) => part !== "all" && part !== "history")) throw new Error("Usage: /durable-jobs [all] [history] | attach <id>");
        const jobs = (await client.list({ all: true })).filter((job) =>
          (parts.includes("all") || job.cwd === ctx.cwd) && (parts.includes("history") || relevant(job)));
        if (!stillHere()) return;
        ctx.ui.notify(jobs.map((job) => `${job.id} [${job.state}] ${compact(job.goal, 120)}${sameOwner(job.owner, owner) ? " (owned)" : ""}`).join("\n") || "No jobs.", "info");
        ctx.ui.notify("Attach explicitly: /durable-jobs attach <id>. Full details: durable_inspect.", "info");
      },
    });
  };
}

export default function extension(pi: ExtensionAPI) {
  createExtension(createClient())(pi);
}

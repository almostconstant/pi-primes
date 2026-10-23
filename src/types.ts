import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type JobState = "running" | "interrupted" | "completed" | "failed" | "cancelled";
export type Job = {
  id: string;
  goal: string;
  context: string;
  cwd: string;
  createdBy: { client: "pi"; sessionId: string };
  model: { provider: string; modelId: string };
  thinking: ModelThinkingLevel;
  tools: "none" | "read" | "local";
  state: JobState;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  activity: string;
  result: string | null;
  error: string | null;
};
export type JobSummary = Omit<Job, "context" | "result">;
export type StartInput = Pick<Job, "goal" | "cwd" | "createdBy" | "model" | "thinking"> & {
  context?: string;
  tools?: Job["tools"];
};
export type ListInput = { cwd?: string; offset?: number; limit?: number };
export type JobPage = { jobs: JobSummary[]; nextOffset: number | null };
export type InspectDetail = "status" | "result" | "transcript";
export type Inspection = {
  recordPath: string; storagePath: string;
  job: JobSummary & { result?: string | null };
  worker: { pid: number }; usage: unknown; entries: unknown[]; blocked: unknown[]; live: unknown;
  truncated: boolean;
};
export interface JobClient {
  start(input: StartInput): Promise<JobSummary>;
  list(input?: ListInput): Promise<JobPage>;
  inspect(id: string, detail?: InspectDetail): Promise<Inspection>;
  resume(id: string): Promise<JobSummary>;
  cancel(id: string): Promise<JobSummary>;
}
export const unfinished = (state: JobState) => state === "running" || state === "interrupted";
export function summarize(job: Job): JobSummary {
  const { context: _context, result: _result, ...summary } = job;
  return { ...summary, goal: summary.goal.slice(0, 240), error: summary.error?.slice(0, 500) ?? null };
}

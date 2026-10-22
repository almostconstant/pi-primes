export type Owner = { sessionId: string; sessionFile: string | null };
export type JobState = "running" | "waiting_for_input" | "interrupted" | "completed" | "failed" | "cancelled";
export type Attention = {
  id: string;
  kind: "needs_input" | "completed" | "failed" | "interrupted";
  message: string;
  acknowledged: boolean;
};
export type Job = {
  id: string;
  goal: string;
  context: string;
  cwd: string;
  owner: Owner;
  model: { provider: string; modelId: string };
  tools: "none" | "read" | "local";
  state: JobState;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  activity: string;
  question: string | null;
  result: string | null;
  error: string | null;
  attention: Attention | null;
  run: number;
  input: string;
};
export type JobSummary = Omit<Job, "context" | "input" | "result">;
export type StartInput = {
  goal: string;
  context?: string;
  cwd: string;
  owner: Owner;
  model: Job["model"];
  tools?: Job["tools"];
};
export type ListInput = { cwd?: string; all?: boolean };
export type Inspection = { recordPath: string; job: Job; worker: { pid: number }; usage: unknown; entries: unknown[]; blocked: unknown[]; live: unknown };
export interface JobClient {
  start(input: StartInput): Promise<JobSummary>;
  list(input?: ListInput): Promise<JobSummary[]>;
  inspect(id: string): Promise<Inspection>;
  reply(id: string, message: string): Promise<JobSummary>;
  resume(id: string): Promise<JobSummary>;
  cancel(id: string): Promise<JobSummary>;
  attach(id: string, owner: Owner): Promise<JobSummary>;
  acknowledge(id: string, eventId: string): Promise<JobSummary>;
}
export const unfinished = (state: JobState) => ["running", "waiting_for_input", "interrupted"].includes(state);
export function summarize(job: Job): JobSummary {
  const { context: _context, input: _input, result: _result, ...summary } = job;
  return { ...summary, goal: summary.goal.slice(0, 240), question: summary.question?.slice(0, 2000) ?? null, error: summary.error?.slice(0, 500) ?? null };
}

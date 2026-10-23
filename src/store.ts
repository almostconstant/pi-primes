import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job } from "./types.js";

export class JobStore {
  constructor(readonly directory: string) {}
  path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid job ID");
    return join(this.directory, id);
  }
  async load(): Promise<Job[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const jobs: Job[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      let raw: string;
      try { raw = await readFile(join(this.path(name), "job.json"), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Initial save never committed.
        throw error;
      }
      const record = JSON.parse(raw);
      if (record.version !== 2 || record.job?.id !== name) throw new Error(`Unsupported or corrupt MVP job record: ${name}; use a separate PI_PRIMES_HOME for PR #1 data`);
      jobs.push(record.job);
    }
    return jobs;
  }
  async save(job: Job) {
    const directory = this.path(job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.job-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 2, job })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(directory, "job.json"));
      const folder = await open(directory, "r");
      try { await folder.sync(); } finally { await folder.close(); }
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

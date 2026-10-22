import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, open, chmod } from "node:fs/promises";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { Inspection, JobClient, JobSummary, ListInput, Owner, StartInput } from "./types.js";

export function stateDirectory() {
  return resolve(process.env.PI_PRIMES_HOME ?? join(homedir(), ".local", "state", "pi-primes"));
}
export function socketPath(home: string) { return join(home, "worker.sock"); }

export class Client implements JobClient {
  constructor(readonly home = stateDirectory()) {}
  private request<T>(method: string, args: unknown[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: socketPath(this.home), path: "/rpc", method: "POST", headers: { "content-type": "application/json" } }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; if (body.length > 4_000_000) req.destroy(new Error("Worker response too large")); });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const result = JSON.parse(body);
            if (response.statusCode !== 200) reject(new Error(result.error || "Worker request failed"));
            else resolve(result.value);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(30_000, () => req.destroy(new Error("Worker request timed out; job may still be running. List jobs before retrying.")));
      req.on("error", reject);
      req.end(JSON.stringify({ method, args }));
    });
  }
  private async ensure() {
    try { await this.request("ping"); return; }
    catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);
    for (let attempt = 0; attempt < 100; attempt++) {
      // A shutting-down worker may release its socket before its lock. Retry lock acquisition.
      if (attempt % 10 === 0) await this.launch();
      await sleep(100);
      try { await this.request("ping"); return; }
      catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    throw new Error(`Worker failed to start; inspect ${join(this.home, "worker.log")}. Requires Node >=22 and flock.`);
  }
  private async launch() {
    const log = await open(join(this.home, "worker.log"), "a", 0o600);
    try {
      const entry = fileURLToPath(new URL("./worker.ts", import.meta.url));
      const loader = fileURLToPath(import.meta.resolve("tsx/esm"));
      // flock's inherited lock survives exec; competing launch attempts cannot open storage together.
      const worker = spawn("flock", ["--nonblock", "--no-fork", join(this.home, "worker.lock"), "node", "--import", loader, entry, this.home], {
        cwd: dirname(entry), detached: true, stdio: ["ignore", log.fd, log.fd],
      });
      worker.on("error", () => undefined);
      worker.unref();
    } finally { await log.close(); }
  }
  private async call<T>(method: string, args: unknown[] = []): Promise<T> {
    await this.ensure();
    // Never retry a mutating request after an ambiguous transport failure.
    return this.request<T>(method, args);
  }
  start(input: StartInput) { return this.call<JobSummary>("start", [input]); }
  list(input: ListInput = {}) { return this.call<JobSummary[]>("list", [input]); }
  inspect(id: string) { return this.call<Inspection>("inspect", [id]); }
  reply(id: string, message: string) { return this.call<JobSummary>("reply", [id, message]); }
  resume(id: string) { return this.call<JobSummary>("resume", [id]); }
  cancel(id: string) { return this.call<JobSummary>("cancel", [id]); }
  attach(id: string, owner: Owner) { return this.call<JobSummary>("attach", [id, owner]); }
  acknowledge(id: string, eventId: string) { return this.call<JobSummary>("acknowledge", [id, eventId]); }
}
export function createClient(): JobClient { return new Client(); }

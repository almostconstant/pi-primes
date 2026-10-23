import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "../src/client.js";
import { until } from "./helpers.js";

test("concurrent clients autostart one worker even when host execPath is Pi, not Node", { timeout: 45_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "primes-client-"));
  const original = process.execPath;
  const nodeOptions = process.env.NODE_OPTIONS;
  let pid: number | undefined;
  try {
    // Simulate old worker's socket gone but lock still held during shutdown.
    const holder = spawn("flock", ["--no-fork", join(home, "worker.lock"), "sh", "-c", "echo ready; sleep 1.5"], { stdio: ["ignore", "pipe", "inherit"] });
    await once(holder.stdout!, "data");
    process.execPath = "/not-a-node-interpreter/pi";
    process.env.NODE_OPTIONS = `${nodeOptions ?? ""} --import=${new URL("./fixture-keepalive.mjs", import.meta.url).href}`;
    assert.deepEqual(await Promise.all([new Client(home).list(), new Client(home).list()]), [{ jobs: [], nextOffset: null }, { jobs: [], nextOffset: null }]);
    pid = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: join(home, "worker.sock"), method: "POST", path: "/rpc" }, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve(JSON.parse(body).value.pid));
      });
      req.on("error", reject); req.end(JSON.stringify({ method: "ping", args: [] }));
    });
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, "worker.sock"))).mode & 0o777, 0o600);
  } finally {
    process.execPath = original;
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = nodeOptions;
    if (pid) {
      process.kill(pid, "SIGTERM");
      await until(async () => stat(join(home, "worker.sock")).then(() => false, () => true), value => value);
      await until(async () => {
        try { process.kill(pid!, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
      }, value => value, 3000);
    }
    await rm(home, { recursive: true, force: true });
  }
});

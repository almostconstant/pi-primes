import { createServer } from "node:http";
import { chmod, unlink } from "node:fs/promises";
import { socketPath } from "./client.js";
import type { Engine } from "./engine.js";

export async function serve(engine: Engine, home: string) {
  // Caller holds exclusive worker.lock before unlinking a stale socket or opening storage.
  await unlink(socketPath(home)).catch(error => { if (error.code !== "ENOENT") throw error; });
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    try {
      if (request.method !== "POST" || request.url !== "/rpc") throw new Error("Unknown endpoint");
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 300_000) throw new Error("Request too large");
      }
      const { method, args } = JSON.parse(body);
      if (!Array.isArray(args)) throw new Error("Invalid arguments");
      let value: unknown;
      switch (method) {
        case "ping": value = { pid: process.pid, version: 1 }; break;
        case "start": value = await engine.start(args[0]); break;
        case "list": value = await engine.list(args[0]); break;
        case "inspect": value = await engine.inspect(args[0]); break;
        case "reply": value = await engine.reply(args[0], args[1]); break;
        case "resume": value = await engine.resume(args[0]); break;
        case "cancel": value = await engine.cancel(args[0]); break;
        case "attach": value = await engine.attach(args[0], args[1]); break;
        case "acknowledge": value = await engine.acknowledge(args[0], args[1]); break;
        default: throw new Error("Unknown method");
      }
      response.end(JSON.stringify({ value }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(home), () => { server.off("error", reject); resolve(); });
  });
  await chmod(socketPath(home), 0o600);
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void engine.tick().catch(error => {
      // A registry persistence failure is fatal: never continue with unrecorded state.
      console.error("Monitor failed", error);
      process.exitCode = 1;
      void shutdown();
    }).finally(() => { ticking = false; });
  }, 500);
  let closing: Promise<void> | undefined;
  function shutdown() {
    return closing ??= (async () => {
      clearInterval(timer);
      server.close();
      await engine.close();
      await unlink(socketPath(home)).catch(error => { if (error.code !== "ENOENT") throw error; });
    })();
  }
  return { server, close: shutdown };
}

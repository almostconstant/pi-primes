import type { InspectDetail } from "./types.js";
import { Client } from "./client.js";

const [command = "list", id, ...rest] = process.argv.slice(2);
const client = new Client();
try {
  let value: unknown;
  switch (command) {
    case "list": value = await client.list({ cwd: process.argv.includes("--global") ? undefined : process.cwd(), all: process.argv.includes("--all") }); break;
    case "inspect": value = await client.inspect(id!, (rest[0] ?? "status") as InspectDetail); break;
    case "resume": value = await client.resume(id!); break;
    case "cancel": value = await client.cancel(id!); break;
    case "reply": value = await client.reply(id!, rest.join(" ")); break;
    case "ack": value = await client.acknowledge(id!, rest[0]!); break;
    default: throw new Error("Usage: npm run jobs -- list [--global] [--all] | inspect ID [status|result|transcript] | resume ID | cancel ID | reply ID MESSAGE | ack ID EVENT_ID");
  }
  console.log(JSON.stringify(value, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

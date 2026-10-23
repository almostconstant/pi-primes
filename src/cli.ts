import type { InspectDetail } from "./types.js";
import { Client } from "./client.js";

const [command = "list", id, detail] = process.argv.slice(2);
const client = new Client();
try {
  let value: unknown;
  switch (command) {
    case "list": {
      const args = process.argv.slice(3);
      if (args.some(arg => arg !== "--global" && !/^\d+$/.test(arg)) || args.filter(arg => /^\d+$/.test(arg)).length > 1) throw new Error("Usage: list [--global] [offset]");
      value = await client.list({ cwd: args.includes("--global") ? undefined : process.cwd(), offset: Number(args.find(arg => /^\d+$/.test(arg)) ?? 0) });
      break;
    }
    case "inspect": value = await client.inspect(id!, (detail ?? "result") as InspectDetail); break;
    case "resume": value = await client.resume(id!); break;
    case "cancel": value = await client.cancel(id!); break;
    default: throw new Error("Usage: npm run jobs -- list [--global] [offset] | inspect ID [status|result|transcript] | resume ID | cancel ID");
  }
  console.log(JSON.stringify(value, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

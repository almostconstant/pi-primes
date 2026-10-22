import { setTimeout as sleep } from "node:timers/promises";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Model, ProviderStreams } from "@earendil-works/pi-ai";

const model: Model<"openai-completions"> = {
  provider: "fixture", id: "fixture", name: "fixture", api: "openai-completions", baseUrl: "http://unused",
  input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function fixtureModels() {
  const stream: ProviderStreams["streamSimple"] = (_model, transcript, options) => {
    const events = new AssistantMessageEventStream();
    void (async () => {
      const input = transcript.messages.find(message => message.role === "user");
      const goal = input?.role === "user" && typeof input.content === "string" ? input.content : "";
      const results = transcript.messages.filter(message => message.role === "toolResult");
      const answer: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: "stop", content: [{ type: "text", text: "Fixture result" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      events.push({ type: "start", partial: answer });
      try {
        if (goal.startsWith("slow")) await sleep(1500, undefined, { signal: options?.signal });
        if (goal.startsWith("ask") && !results.length) {
          answer.stopReason = "toolUse";
          answer.content = [{ type: "toolCall", id: "ask", name: "ask_parent", arguments: { question: "Which audience?" } }];
        } else if (goal.startsWith("shell:") && !results.length) {
          answer.stopReason = "toolUse";
          answer.content = [{ type: "toolCall", id: "shell", name: "bash", arguments: { command: goal.slice(6) } }];
        } else if (results.length) {
          answer.content = [{ type: "text", text: `Observed: ${JSON.stringify(results)}` }];
        }
        events.push({ type: "done", reason: answer.stopReason as "stop" | "toolUse", message: answer });
      } catch {
        answer.stopReason = "aborted";
        events.push({ type: "error", reason: "aborted", error: answer });
      }
    })();
    return events;
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "fixture", models: [model], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  return models;
}

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const start = Date.now();
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

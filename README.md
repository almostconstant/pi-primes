# Pi Primes

Durable, goal-driven delegated agents for Pi. No predefined task types or workflow stages.

A Pi extension is the client. An independent local worker owns execution and storage. Closing or crashing parent Pi does not stop its job. Jobs remain discoverable without their original parent or ID.

## Try locally

Requires **Node 22+**, `npm`, Unix sockets, and util-linux **`flock`** on `PATH` (Linux). This first version runs from a local checkout; keep its dependencies and path available while workers run.

```sh
npm ci
npm run check
npm test
pi --extension ./src/extension.ts
```

No personal Pi settings are changed. This is not yet a standalone published package: worker uses the installed development copies of Pi's model runtime and `pi-ai` 1.4.0 alongside `pi-durable` 1.4.0. Extension was also smoke-tested in Pi CLI 1.2.0. Do not install with `--omit=dev`.

Ask Pi to delegate a goal. `durable_start` accepts:

```json
{
  "goal": "Compare these proposals and recommend next steps",
  "context": "Only explicit information the child needs. Empty string is allowed.",
  "tools": "none"
}
```

Parent's selected provider/model is captured. Worker loads standard Pi credentials and model configuration itself, including request-time OAuth refresh. It does **not** inherit parent transcript, skills, project instructions, MCP servers, extension-only providers, virtual models, or runtime API-key overrides. Supply relevant instructions/context explicitly. Restart worker to reload model configuration or code after updating this checkout. Stop it gracefully first; resume interrupted jobs explicitly.

### Capabilities

| Tools | Child capabilities |
| --- | --- |
| `none` (default) | Model reasoning and `ask_parent`; no file or shell tools |
| `read` | Also built-in file reading |
| `local` | Also file writing/editing and shell commands |

`local` is full user-level local execution, including network access through shell. It is **not a sandbox**. Parent permission hooks are not inherited. A working directory is context, not filesystem isolation. Use only with trusted goals/context; arrange external isolation for untrusted work. No automatic worktree, merge, push, or recursive delegation.

## Control and discovery

| Tool | Purpose |
| --- | --- |
| `durable_start` | Start one independent job; return ID immediately after admission |
| `durable_list` | Compact unfinished jobs and unacknowledged outcomes in current cwd |
| `durable_inspect` | Compact status/usage by default; `detail: "result"` or `"transcript"` explicitly fetches more |
| `durable_reply` | Answer pending `ask_parent` question; execution continues automatically |
| `durable_resume` | Explicitly recover interrupted worker execution |
| `durable_cancel` | Abort job and active commands; retain history and partial artifacts |
| `durable_attach` | Transfer ownership/notification routing to current parent session |
| `durable_acknowledge` | Acknowledge exact notification and completed parent response persisted in owning branch |

`durable_list` has independent `allScopes` and `allHistory` switches. Listing never adopts jobs. `/durable-jobs`, `/durable-jobs all history`, and `/durable-jobs attach <id>` provide UI discovery without injecting inventory into model context.

Headless recovery does not require parent Pi or its transcript:

```sh
npm run jobs -- list --global
npm run jobs -- list --global --all
npm run jobs -- inspect JOB_ID
npm run jobs -- inspect JOB_ID result
npm run jobs -- inspect JOB_ID transcript
npm run jobs -- resume JOB_ID
npm run jobs -- reply JOB_ID "Missing context"
npm run jobs -- cancel JOB_ID
npm run jobs -- ack JOB_ID EVENT_ID
```

Inspection detail is selected in the worker, before transport. Status/results never load transcript entries or live tool payloads. Transcript preview contains at most 20 recent entries, omits individual entries/live state over 50,000 serialized characters, and marks omitted/older content with `truncated`. Result previews cap at 100,000 characters. `recordPath` points to the complete job/result; `storagePath` points to full durable transcript storage. Preview limits do not change persisted data or replay safety. Default inspection returns compact job metadata, not supplied context/input.

One job executes at a time, including time spent waiting for input. Another start is rejected, not queued. Arbitrarily many historical/interrupted jobs can remain in registry. Completed/failed jobs cannot be extended with another prompt in v1; start another job. Mid-run steering is not implemented; reply answers an explicit pending question only.

## Notifications without context bloat

Routine progress stays in worker storage. Polling updates a UI-only count; it does not inject logs or status messages into parent conversation.

Child explicitly calls `ask_parent` when blocked on missing context, authority, or a decision. Its question and eventual answer are durable. Silence is not automatically classified as stuck.

Needs-input, completion, failure, and interrupted-worker events produce one compact custom parent message. Idle parent wakes automatically. While parent is busy, event remains in durable registry and is delivered once idle; it is not put into Pi's clearable follow-up queue. While parent is offline, event waits for owning session to reconnect. Different sessions must attach explicitly.

Acknowledgment requires both the notification and a subsequent completed assistant response (`stopReason: "stop"`) persisted in active parent branch. A saved receipt alone does not consume the wakeup: reconnect retries it if the parent crashed before responding. Aborted/error/tool-call-only responses do not count. Each session/branch lifecycle attempts a given wakeup once, avoiding automatic spending loops after parent errors or aborts; reconnect/reload or branch re-entry permits another attempt. Busy parents still wait until idle.

Reconnect deduplicates already completed responses. Ownership transfer rotates an unacknowledged event ID so stale parents cannot consume its notification. This proves a completed response, not successful external effects or exactly-once model execution. In-memory parent sessions cannot confirm disk persistence; their outcomes remain discoverable as unacknowledged.

## Persistence and recovery

Default state: `~/.local/state/pi-primes`. Override with `PI_PRIMES_HOME` (use same value in parent and recovery CLI). Keep path short enough for Unix sockets.

```text
worker.lock           flock prevents concurrent storage owners
worker.sock           private local RPC, mode 0600
worker.log            diagnostics; may contain sensitive task errors
jobs/<uuid>/job.json   versioned registry record, atomic rename + fsync
jobs/<uuid>/durable/   pi-durable JSONL conversations/tasks/documents
```

State directory is mode 0700. Goal, context, outputs, and tool results may contain sensitive information; they are not encrypted. Credentials are loaded from Pi, not copied into job records. Registry and durable conversation are separate stores: persisted request IDs reconcile admission after crashes without duplicating the original input. An initial registry save that never committed is skipped; malformed committed records fail loudly rather than silently losing jobs.

- Parent exit/abort/reload: worker continues.
- Worker crash or host reboot: next client starts worker, marks unfinished jobs interrupted, and notifies owner. Inspect, then explicitly resume or cancel. No service manager or automatic boot-time execution.
- Resume reuses original durable submission. Restart-limit-parked tasks receive explicit retry. Other blocked definitions require code/version repair.
- Inspection never enables durable task scheduling. Model removal does not prevent inspection/cancellation.
- Cancellation intent is persisted before aborting. If interrupted, repeat cancel; resume cannot accidentally undo cancellation.
- `SIGTERM` to worker PID from inspection stops worker gracefully without cancelling jobs. Resume explicitly after restarting it. There is no worker-stop command yet.

Interrupted unsafe shell/write/edit calls are **not automatically replayed by runtime**. Their external effects may already have happened; the model may still issue a fresh call. Reconcile partial artifacts before resuming sensitive work. `SIGKILL` cannot clean up shell descendants; surviving commands may continue until they exit. Normal cancellation is tested to stop active command processes.

JSONL persistence targets process-crash recovery, not a verified full power-loss guarantee. Upstream API is experimental. No automatic deletion, retention policy, backup tool, or storage migration beyond version rejection. Back up state while worker is stopped; never independently open its durable storage while worker owns it.

## Development boundaries

- `src/extension.ts`: Pi lifecycle, tools, UI-only status, notification receipts.
- `src/client.ts`, `src/server.ts`: private local RPC and detached worker startup.
- `src/engine.ts`: job lifecycle, admission, discovery, ownership, attention events.
- `src/store.ts`: versioned registry persistence.
- `src/runtime.ts`: only `pi-durable` execution integration; engine consumes a small injectable `Runtime` interface.
- `src/worker.ts`: model credentials and process composition.
- `src/types.ts`: shared client contract and job records.

Change capability/runtime behavior without changing notification transport; test lifecycle policy without model calls. Keep storage field changes versioned and add migrations before supporting incompatible persisted formats. No workflow DSL or generic plugin framework.

Tests use actual durable JSONL storage and deterministic provider fixtures, including separate parent/worker processes, worker `SIGKILL`, reconnect/discovery, question recovery, stale acknowledgments, unsafe replay, and command cancellation. Notification tests mock Pi lifecycle. A live smoke test additionally exercised Pi 1.2.0 with a real provider: parent exit, persisted question, reconnect auto-wake, parent reply, child completion.

## Current limits

No parallel execution, remote workers, custom TUI, automatic integration, inherited tools/resources, mid-run steering, or recursive agents. No hard token/cost/wall-time caps yet: detached jobs can spend until completion, failure, explicit question, or cancellation. Use bounded goals and monitor usage. Worker startup allows about 30 seconds, including cold dependency loading. Startup/transport timeouts are not execution budgets.

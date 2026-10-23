# Pi Primes: durable jobs MVP

Delegate explicit goals from Pi, close the parent, then discover and inspect saved outcomes. Multiple jobs can run concurrently in one project/session or across projects.

A Pi extension is the client. One detached local worker runs independent `pi-durable` harnesses, one per job. Parent exit does not stop jobs. Worker exit or container restart interrupts them; recovery is explicit.

## Run from this checkout

Requires **Node 22+**, npm, Linux Unix sockets, and util-linux **flock** on PATH.

```sh
npm ci
npm run check
npm test
pi --extension ./src/extension.ts
```

Keep this checkout, its path, and its development dependencies available while the worker runs. No personal Pi configuration is changed. This is not a standalone published package. The worker uses the installed Pi/model runtime and `pi-durable` **1.4.0**; do not install with `--omit=dev`.

## Start a job

Ask Pi to use `durable_start`:

```json
{
  "goal": "Review the parser and report concrete correctness problems; do not edit files",
  "context": "Inspect src/parser.ts and its tests. Report paths, reproduction cases, and smallest fixes.",
  "tools": "read",
  "model": { "provider": "openai-codex", "modelId": "gpt-6.1-sol" },
  "thinking": "medium"
}
```

Goal and context are explicit; context can be empty. Omitted model/thinking use the parent's current selections, resolved and saved at start. The worker rejects unknown/unavailable models and unsupported thinking levels **before admission**, rather than silently changing settings. Model availability means configured worker authentication, not a guarantee the provider will accept its next request.

Tools are selected at initialization:

| Preset | Capabilities |
| --- | --- |
| `none` (default) | Model reasoning only |
| `read` | Also file reading |
| `local` | Also file writes, edits, and shell commands |

The child does not inherit parent transcript, project instructions, skills, MCP servers, extensions, extension-only/virtual models, or runtime key overrides. Supply needed instructions in context. The worker loads standard Pi credentials/configuration and handles request-time OAuth refresh separately; credentials are not copied into job records.

**Containers are an outer boundary, not per-job isolation.** `local` has the worker user's file/shell/network permissions; `read` is not confined to the working directory. Parent permission hooks are not inherited. Concurrent jobs modifying the same checkout can conflict. Provide separate worktrees/directories when needed; this MVP does not create them.

If essential information or authority is missing, the child is instructed to stop and report its blocker. Clarification starts a **new job**, supplying the prior result as context. No waiting questions or replies. `completed` means the child produced a final report, not proof that its goal succeeded: read its outcome/evidence/blocker.

## Manual discovery and inspection

No background polling, automatic parent wakeups, or model turns on completion.

```text
/jobs                  Latest 50 saved jobs in current project, including outcomes
/jobs 50               Next page (follow the offset shown)
/jobs all              Include other projects
/job JOB_ID            Saved result/error, settings, and storage paths
/job JOB_ID status     Compact status without result
/job JOB_ID transcript Explicit bounded recent transcript preview
```

Commands display UI-only notifications. `/job` previews at most 4,000 characters and always gives full storage paths if truncated; use `durable_inspect` or the CLI for a larger preview. Listing works after restarting Pi without remembering job IDs. These commands require UI; use tools/CLI in headless mode.

Model-callable tools:

- `durable_start`: return job ID immediately after admission/submission, not completion.
- `durable_list`: current project by default; `allScopes: true` widens scope. `offset`/`limit` page through all saved jobs (default 50, maximum 100); follow `nextOffset` until null.
- `durable_inspect`: result by default; explicit `detail: "status"` or `"transcript"`.
- `durable_cancel`: stop one job and its active commands; keep history/partial artifacts. Other jobs continue.
- `durable_resume`: explicitly resume interrupted execution after inspecting uncertain effects. Cannot extend completed/failed/cancelled jobs.

Scope filtering and pagination happen **in the worker before transport**. Model-facing lists compact rows and may return fewer than the requested count to fit Pi's output bound; their adjusted `nextOffset` never skips hidden rows. Inspect a job for full settings/paths. Status/result requests do not load transcript previews. Results cap at 100,000 characters; transcript previews cap at 20 recent entries, omitting individual entries/live state above 50,000 serialized characters. `truncated` and storage paths point to complete persisted data. Preview bounds never modify stored data.

Lists use offsets over newest-first results; newly admitted jobs can move page boundaries. Restart listing if the inventory changes while paging.

Recovery CLI, without a running parent Pi:

```sh
npm run jobs -- list
npm run jobs -- list --global 50
npm run jobs -- inspect JOB_ID
npm run jobs -- inspect JOB_ID transcript
npm run jobs -- cancel JOB_ID
npm run jobs -- resume JOB_ID
```

## Persistence and recovery

Default state is `~/.local/state/pi-primes-mvp`. Set **PI_PRIMES_HOME** consistently in parent and CLI to override. Keep the path short enough for Unix sockets. Use persistent container storage if jobs must survive container replacement.

```text
worker.lock           flock: only one worker owns this state directory
worker.sock           private local RPC (protocol version 2)
worker.log            diagnostics, possibly sensitive
jobs/<uuid>/job.json   Version-2 registry record, atomic rename and fsync
jobs/<uuid>/durable/   pi-durable execution checkpoints and conversation JSONL
```

Registry records hold job ID, immutable creator Pi session ID, project cwd, explicit goal/context, resolved model/thinking/tools, timestamps, status, result/error, and cancellation intent. Each durable submission uses its stable job ID as request ID, reconciling registry admission and runtime storage without duplicating original input after a crash.

- **Parent exits:** worker and all jobs continue. Reopen Pi and list/inspect.
- **Worker/container exits:** next client starts a worker; formerly running jobs become `interrupted`. Listing/inspection never schedules them. Inspect, reconcile partial effects, then explicitly resume or cancel each job independently.
- **Resume:** reuses the existing durable submission/checkpoints. Only `restart_limit`-parked tasks receive explicit retry; other blocked definitions need code/version repair.
- **Cancel:** saves intent before aborting. If interrupted or uncertain, repeat cancel; resume rejects outstanding cancellation intent. Cancelling recovered work marks paused tasks before enabling cleanup, avoiding new execution during cancellation.
- **Graceful worker stop:** send SIGTERM to PID returned by inspection. It closes all harnesses without cancelling jobs; restart and explicitly resume. Restart worker after changing code/model configuration.

Interrupted writes/edits/shell calls are marked **unsafe** and are not automatically replayed by the runtime. Their external effects may already have happened, and the model could later issue a fresh call. Reconcile sensitive partial work before resume. SIGKILL cannot clean up shell descendants; commands can continue until they exit. Graceful cancellation cleans up active commands.

State is restricted to the current user (directory 0700, records/socket 0600), not encrypted. Goal, context, output, tool results, and logs may be sensitive. Job history is kept indefinitely. Back up state while the worker is stopped; never independently open live durable storage.

JSONL targets process-crash recovery, not a verified full power-loss guarantee. A worker must own the flock before opening storage. Initial uncommitted registry saves are skipped; malformed/unsupported committed records fail loudly. Client never automatically retries ambiguous mutating requests: list/inspect before deciding what happened.

This branch replaces the larger PR #1 prototype, **not its persisted data**. Default state uses a separate directory; old workers, branches, and data are untouched. Version-1 records/protocol are rejected; no migration is provided.

## Code and checks

- `src/extension.ts`: five tools and two manual commands; no session lifecycle machinery.
- `src/client.ts`, `server.ts`, `worker.ts`: local RPC, detached startup, exclusive ownership.
- `src/engine.ts`, `store.ts`: concurrent job lifecycle and bounded registry discovery.
- `src/runtime.ts`: pi-durable harness, selected capabilities/model/thinking, recovery.
- `src/types.ts`: small shared contract. `src/cli.ts`: manual headless recovery.

```sh
npm run check
npm test
```

Tests use real durable JSONL storage and deterministic provider fixtures. They cover same-session/cross-project concurrency, parent exit and rediscovery, worker SIGKILL, isolated explicit resume/cancel, unsafe-effect replay, model/thinking validation and forwarding, tool selection, blockers, UTF-8 chunk boundaries, large transcripts, and bounded historical inventory, including model-facing pagination without skipped rows. A Pi CLI 1.2.0 RPC load smoke verified both commands register without starting a worker. Live-provider/OAuth behavior and interactive TUI rendering were not exercised for this MVP.

No queues, priorities, hard spending/resource caps, remote hosting, multi-user authorization, recursive delegation, ownership transfer, reply protocol, automatic notifications, acknowledgment proofs, SQLite migration, or automatic cleanup. Concurrent detached jobs can spend independently; cancel unwanted work.

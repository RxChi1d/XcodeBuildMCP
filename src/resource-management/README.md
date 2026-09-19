# Simulator resource-management core

This experimental implementation provides a filesystem registry and opt-in MCP, CLI, and daemon integration. Importing the core has no side effects. Explicit provisioning creates and verifies a dedicated Simulator through a supervised command adapter. Managed boot waits for readiness under an operation lease. Reset and deletion remain unsupported, and there is deliberately no public command to adopt an existing device. Dedicated-device provisioning, boot, screenshots, and live MCP session handoff have also been validated on iOS 27.0; managed test execution remains subject to the validation limits described below.

## Runtime opt-in

Set both `XCODEBUILDMCP_OPERATION_STATE_ROOT` (an absolute private directory outside all worktrees and installed tool storage) and `XCODEBUILDMCP_OPERATION_CAPACITY` (a positive integer) in every participating process. Use the same absolute root spelling and capacity. These settings are separate from `XCODEBUILDMCP_RESOURCE_ROOT`, which selects packaged manifests and other static resources.

Managed runtimes put workspace artifacts and daemon registry files under `<operation-state-root>/runtime`. Their temporary Unix socket namespace includes the operation registry identity. Arbitrary socket and daemon log-path overrides are rejected. Clients verify the daemon's matching namespace before invoking tools; a managed protocol mismatch never triggers automatic termination or restart. Operation credentials travel as explicit tool arguments, including across daemon routing, and never enter session defaults.

Configure these settings through the MCP client's normal server configuration. No session-resume script or particular client session ID is required. The caller supplies its own operation session UUID, independently of the client's conversation identifier. Keep the registry in durable storage for persistent bindings; deleting a temporary test directory does not retire its Simulator.

`resource_provision` and `resource_operation` are automatically included in managed MCP sessions. Provisioning requires explicit `deviceType` and `runtime` identifiers. The CLI entry is:

```sh
xcodebuildmcp resource-management provision --device-type <device-type-identifier> --runtime <runtime-identifier>
```

Choose full identifiers from the installed Simulator catalog, such as `com.apple.CoreSimulator.SimDeviceType.iPhone-16` and `com.apple.CoreSimulator.SimRuntime.iOS-18-0`, only when they are available on the host. The command verifies existing bindings without creating replacements. Provisioning does not begin an operation or boot the device; begin an operation before explicitly requesting boot readiness.

`resource_operation` has the CLI entry `resource-management operation`. It accepts:

| Action | Required arguments | Result |
| --- | --- | --- |
| `begin` | `requestId`, `sessionId` | Registers/retries a request and returns state, UDID, and token; may return `waiting` |
| `poll` | `requestId`, `sessionId`, `token` | Schedules eligible work and returns current lease |
| `status` | `requestId` | Returns state and activity count without the token |
| `end` | `requestId`, `sessionId`, `token` | Closes active work and releases after admitted calls drain |
| `cancel` | `requestId`, `sessionId`, `token` | Cancels waiting work or drains an active operation |

All actions resolve the current Git worktree. Begin fails if it has no binding. Non-begin actions reject requests belonging to another worktree generation. A new session uses a new session UUID and begins a new operation after its predecessor ends; it does not inherit the predecessor's token. Keep begin's request/session identities when a response is lost and retry them.

The currently admitted device tools are `boot_sim`, `build_sim`, `test_sim`, `install_app_sim`, `launch_app_sim`, `screenshot`, `snapshot_ui`, `tap`, and `type_text`. In managed mode their public schemas require `simulatorId`, `operationRequestId`, `operationSessionId`, and `operationToken`. Parameter validation and session-default merging happen before checking the final UUID and worktree binding. A call waits at most 30 seconds for another call on the same token, without ending the operation on timeout.

All other manifest tools and Xcode bridge calls are rejected in managed mode, including `get_app_bundle_id`, `get_sim_app_path`, `open_sim`, `build_run_sim`, standalone `build-for-testing`, prepared-test execution, erase, stop-app, debugger, batch/wait and other UI actions, recording, and background logging. These tools either lack a bound Simulator target or need a separate supervised read-only contract, so they are not admitted by the initial lease surface. This also means session-default setters are unavailable in this initial managed mode. Startup does not perform automatic Simulator-default refresh, Xcode synchronization, or orphan cleanup. Ordinary runtimes without the opt-in keep their existing behavior; they do not participate in the lease guarantee. Normal MCP and native session resume operate without any external resume script dependency.

The admitted tools use finite command executors. Supervision tracks every such command through async context, including errors swallowed by existing helpers. A returned domain failure with confirmed process completion remains a domain failure and allows explicit end. Unknown exit state, rejected execution, or output streams still open after process exit block the operation even if the tool returns success. No TTL, disconnect, or process death resolves this uncertainty. This supervision tracks direct child exit and closed streams; it does not support detached commands or prove termination of arbitrary process trees or user project build scripts, and tools requiring those remain disabled.

## Managed boot readiness

After provisioning and an active `begin` result, call `boot_sim` with the bound `simulatorId` and the three operation credentials. The CLI equivalent is:

```sh
xcodebuildmcp simulator boot --simulator-id <bound-uuid> --operation-request-id <request-uuid> --operation-session-id <session-uuid> --operation-token <operation-token>
```

The call reads device availability and state, then runs `simctl bootstatus <uuid> -b` to boot if needed and wait for readiness. It verifies the device is available and `Booted` after the command completes. Shutdown, booting, and already booted devices all follow this readiness check. Installation and screenshots remain explicit subsequent calls; keep the same operation until the workflow ends.

An end/cancel request during boot closes admission but cannot release the device until readiness finishes. A confirmed missing/unavailable device before boot produces a domain failure. Uncertain command completion, failed boot status, or failed verification after boot blocks the operation and retains its activity record. A transitional or unknown preflight state also blocks rather than guessing that the service has stopped. There is no automatic timeout reclaim, shutdown, replacement, or unblock. A boot that remains pending keeps its call and operation held.

Managed boot suppresses ordinary boot next-step templates, which do not carry operation credentials and include unsupported display tools. Ordinary mode retains its existing boot behavior. Boot readiness tests inject every command and cover explicit target admission, preflight failures, uncertain completion, and end/waiting-session races; they do not verify real Simulator startup.

## Managed compile-only build

After provisioning and obtaining an active operation lease, invoke `build_sim` with exactly one raw, nonblank source input (`projectPath` or `workspacePath`), a nonblank `scheme`, the bound `simulatorId`, and the three operation credentials. These required source, scheme, and UUID values must be supplied by the call; managed build does not obtain them from session or project defaults. Optional `configuration`, `derivedDataPath`, and `preferXcodebuild` (omitted or `true`) are supported. The CLI equivalent provides the same explicit flags:

```sh
xcodebuildmcp simulator build --project-path <path-to-.xcodeproj> --scheme <scheme> --simulator-id <bound-uuid> --operation-request-id <request-uuid> --operation-session-id <session-uuid> --operation-token <operation-token>
```

Managed build supports compile-only workflows. Admission validates the exactly-one source rule and nonblank required inputs, then rejects non-empty `extraArgs` (including inherited session defaults), `buildForTesting=true`, `testProductsPath`, and explicit `preferXcodebuild=false` before executing any external build commands. Empty `extraArgs` arrays and omitted or `true` `preferXcodebuild` are allowed. `build_run_sim`, standalone `build-for-testing`, and prepared-test production remain unsupported; use the managed `test_sim` workflow for source tests.

Managed builds always execute standard supervised `xcodebuild`. Even if incremental build support (`xcodemake`) is enabled in host or project configuration, managed mode bypasses both the `xcodemake` availability probe and its execution because it uses unsupervised child processes. Effective destinations are bound to the leased Simulator UUID, normalized to uppercase at the `xcodebuild` command boundary to match CoreSimulator/xcodebuild destination specifier requirements while registry, lease, and caller provenance retain their existing identities.

Admission immediately invalidates any existing managed UI snapshot and suppresses all next-step metadata (`nextSteps`, `nextStepParams`, and `nextStepConditionKeys`) because follow-up templates lack credentials or reference unsupported tools. The final structured build result retains schema version 3 (`xcodebuildmcp.output.build-result`).

The operation remains held in `active` state across both successful builds and confirmed compile failures, and is released only upon an explicit `end`. Concurrent `end` moves the lease to `closing` and waits for admitted execution to complete. Infrastructure rejections, unknown exit status, or unclosed output streams block the operation. Supervision covers direct child process termination and closed standard streams; it does not provide arbitrary process-tree guarantees for user build scripts executed by `xcodebuild`.

## Managed simulator tests

After provisioning and obtaining an active operation lease, invoke `test_sim` with exactly one raw, nonblank source (`projectPath` or `workspacePath`), a nonblank `scheme`, the bound `simulatorId`, and the three operation credentials. Required source, scheme, and UUID values must be supplied by the call rather than obtained from defaults. `simulatorName`, prepared test artifacts (`testProductsPath` and `xctestrunPath`), `buildForTesting`, execution and destination overrides, and `preferXcodebuild: false` are rejected before any external command. The safe `-only-testing` and `-skip-testing` selector forms are allowed in `extraArgs`, including inherited session defaults; an empty array and omitted or `true` `preferXcodebuild` are also allowed. `testRunnerEnv` accepts the MCP wire array of `{ key, value }` entries. Admission invalidates the managed UI snapshot and suppresses next-step metadata. The ordinary `test_sim` path retains its existing behavior.

Managed source tests run one supervised `xcodebuild build-for-testing` phase followed by one supervised `xcodebuild test-without-building` phase. The test phase binds the leased Simulator UUID, uses `-parallel-testing-enabled NO` and `-maximum-concurrent-test-simulator-destinations 1`, and preserves the project's and test plan's repetition settings rather than forcing an iteration count. Every confirmed, nonsignaled, consistent numeric nonzero exit from phase 1 remains a domain failure; it does not start phase 2 or shut down the Simulator. Phase 2 accepts only exit 0 or 65 as known outcomes. A normal phase 2 exit of 0 or 65 is followed by asynchronous test failure and summary extraction, shutdown of the specified Simulator, and verification that exactly one available catalog entry for that UUID reports `Shutdown`; result and completion markers are written before the activity finishes.

After a confirmed phase 2 outcome and verified shutdown, the operation remains active with zero activities until the caller explicitly invokes `resource_operation end`. An end request while a call is in flight moves the operation to `closing` and waits for that call to drain. Shutdown stops running Simulator apps and test runners, so running UI state and in-memory process state are lost; installed app containers and on-disk data remain. Signals, rejected or unknown commands, open streams, cleanup failures, and unexpected exceptions after phase 2 starts before shutdown verification block the operation and retain its activity. There is no automatic TTL reclaim, forced end, simulator erase/delete, or automatic reboot. The shutdown check observes the CoreSimulator catalog boundary and does not prove termination of arbitrary host process trees or user project scripts. Follow-up UI work must call `boot_sim` explicitly.

## Managed app launch

After boot readiness and installation, invoke `launch_app_sim` with an explicit `bundleId`, bound `simulatorId`, and the three operation credentials. Optional `launchArgs` and `env` retain their existing input formats. The call checks the installed app container, then runs `simctl launch --terminate-running-process` without a console attachment. This explicitly restarts an already-running copy of the app. Arguments are passed without a shell, and environment names use the existing `SIMCTL_CHILD_` normalization.

Managed launch returns the reported app PID after the command exits with closed output streams. It does not prove that the app will remain healthy or that its UI is ready. An inaccessible app container produces a domain failure before launch. Rejected or unobserved commands, failed launch requests, or missing/mismatched PID output block the operation and preserve its activity record. End/cancel during launch waits for the admitted call; a waiting session is granted only after confirmed completion and release.

The app itself may remain running when the operation ends. It is persistent device state for the next session, not a host helper holding the previous operation. The next session can inspect that state without relaunching. Managed launch creates no implicit console or OSLog helper and returns no log paths; background capture requires a later supervision integration. Ordinary launch retains automatic logging. Managed next-step templates are suppressed because they omit operation credentials and suggest unsupported display/stop tools.

## Managed UI snapshots and actions

Use `snapshot_ui`, then `tap` or `type_text` with a returned `elementRef` and the same operation credentials. Each managed capture assigns fresh opaque references while preserving the published `e<digits>` string format. Copy them exactly; do not convert their numeric portion to a number or construct refs. Actions return a refreshed snapshot when capture succeeds. Always use refs from that refreshed result for the next action. Managed `snapshot_ui` returns a fresh snapshot even when `sinceScreenHash` matches; normal compact MCP rendering still applies.

Before each admitted call, the runtime compares its local snapshot provenance with the durable operation's last completed call. A new operation, an intervening call in another runtime, or boot/build/install/launch/test clears the local snapshot. Even a read-only call in another runtime conservatively requires refreshing. The call lease protects this comparison and all UI commands through post-action capture. Refs remain in memory, cannot be transferred between MCP and a separate daemon, and are invalid after capture refresh. A CLI UI sequence must use the same daemon; a session taking over must capture its own view.

Command supervision stops follow-up work immediately after uncertain exit or open streams, including when a helper catches the initial error. A safely completed action failure remains a domain result; missing dependencies and execution infrastructure failures surface as runtime errors. Uncertain command completion blocks the operation. An observed failure to refresh the UI after an action may return a warning requiring a new snapshot; it cannot authorize reuse of stale refs.

Existing next-step templates are suppressed in managed UI mode because they omit operation credentials and can suggest unsupported tools. Batch, wait, scrolling and other UI tools remain unsupported. Ordinary mode retains its existing short refs and unchanged-snapshot behavior. UUID keys are canonicalized consistently in the local cache, sequence counters and transaction queue.

## Storage and identity

`SimulatorResourceManager.open({ stateRoot, maxActiveOperations })` requires an explicit absolute, private directory outside the installed tool's storage. Binding a worktree rejects a registry located inside that checkout. All participating processes must use the same root and capacity; the persisted configuration rejects capacity mismatches. There is no global default registry.

The registry stores one JSON record per binding and operation. Record updates use same-directory atomic rename. Every activity completion first writes a separate completion receipt, preserving the evidence needed for retries and replay checks. The operation v2 hot record keeps only the most recent completed call; this bounds the live record without deleting completion receipts or historical evidence.

Legacy v1 operations remain v1 while activities are still present and migrate only after they drain. A strict-version older binary rejects a v2 operation, so all participants must be updated before they share v2 records. The existing filesystem lock protects short registry transactions; normal transactions wait at most 10 seconds, while `finishActivity` may wait for the lock to complete finalization and settle a waiting lease without that deadline. A live lock owner is never displaced. The transaction lock's expiry is not an operation expiry.

Records are retained, including completed requests, so retries and orphaned worktrees remain identifiable. A runtime crash leaves durable ownership and activities in place; it does not trigger automatic recovery or unblock. Retention and recovery of temporary files after abrupt termination are not implemented. Atomic visibility across process crashes is supported; power-loss durability is not claimed.

`resolveManagedWorktree(cwd, executor)` uses injected Git commands to locate the checkout root and its individual Git directory. A generation hashes both directories' device number, inode, and nanosecond birth time. Ordinary source edits do not change it; replacing the checkout or Git directory changes it. Missing directory identity data is an error. This is a local-filesystem identity, not a portable ID for restored backups or copied repositories.

The binding retains the original root, Git directory and existing workspace key. Relocation of the same generation is detected and blocked until a future reconciliation implementation can update resource ownership safely. Deleted checkout records remain queryable with `getBinding(generation)`. Multiple project/workspace storage associations are not integrated yet.

`bind(worktree, specification, simulatorId)` is an internal binding boundary. It records the supplied device; it does not discover or adopt an existing device. It rejects worktrees with a provisioning record, including uncertain creation attempts. Device type and runtime must be nonempty, and cannot change once bound. The production adapter validates catalog availability. Simulator UUIDs are normalized before uniqueness checks. A device cannot bind to two generations within one registry.

## Dedicated-device creation coordination

`provision(worktree, specification, create, verifyCreated?)` persists one creation reservation per worktree generation before invoking the injected creator. The creator receives a unique device name and the explicit specification; it must create a new device and return its UUID only after creation has definitively stopped. It must not discover or adopt an existing device. An optional verification callback runs after the observed UUID is saved and before the binding is committed, without holding the registry transaction lock. Verification failure retains the UUID and blocks automatic retries.

The production adapter always supplies this verification callback. It validates explicit available runtime/device-type identifiers, executes `simctl create` without a shell, confirms process exit and closed output streams, and then verifies the returned UUID's availability and device type in its expected runtime. Existing device UUIDs cannot be adopted through the creation response. Missing devices and specification conflicts produce errors without automatic replacement. Malformed catalog output and uncertain command completion surface as runtime errors; expected unavailable-runtime/device and confirmed creation failures produce domain failures.

Creation runs outside the short registry transaction, so a slow creator does not block unrelated operations. Another process finding an unfinished reservation receives an explicit in-progress/reconciliation error and never invokes a second creator. Once the binding commits, retrying provisioning with the same specification returns that binding, even while the original process stays alive. Conflicting specifications fail. Provisioning creates no operation lease, consumes no operation slot, and does not boot the device.

One record under `provisioning/` retains the original worktree, specification, reservation ID, and any observed UUID. `creating` means a reservation exists but completion has not been recorded; `created` means the creator returned an observed UUID; `blocked` means creation or binding completion failed. The binding record is authoritative for whether the device is ready for lease acquisition. The observed UUID is saved before attempting the binding commit, allowing inspection even when the worktree disappears during creation.

`getProvisioning(generation)` reads this evidence after checkout deletion. A process crash can leave `creating` or `created` without a binding, including the gap after device creation but before its UUID is saved. No PID death, age, retry, or direct binding clears that reservation. A recorded UUID also prevents another worktree generation from binding that device, including a new checkout at the same path. The unique creation name can be reconstructed from its ID for future reconciliation. There is no automatic recreation, deletion, or recovery override. Atomic visibility is supported; power-loss durability is not claimed.

## Lease lifecycle

The caller provides a new UUID `sessionId` for its session and a UUID `requestId` for each operation. Identity UUIDs must be lowercase. Retrying a begin uses the same request ID and session ID; it returns the same credentials instead of allocating another operation. These identities are separate from runtime processes and daemon request IDs.

| State | Meaning | Holds device/capacity |
| --- | --- | --- |
| waiting | Queued for its bound device and an operation slot | No |
| active | Caller may register a tool call | Yes |
| closing | End/cancel requested; existing work must drain | Yes |
| blocked | Supervision lost or safe completion is uncertain | Yes |
| released | Operation completed and tracked work stopped | No |
| cancelled | Waiting request cancelled | No |

`requestLease` and `poll` schedule eligible requests in registration order. An occupied device does not prevent an unrelated free device from using spare capacity. This capacity counts operations, including blocked/closing operations, not booted Simulators or total persistent bindings. There is no automatic preemption or idle shutdown. `end` and `cancel` reject a `blocked` operation with an explicit error; they do not claim to release it, and there is no public unblock action because supervision loss leaves completion uncertain.

`acquire(request, { timeoutMs, signal })` waits for a grant. Cancellation and timeout cancel only a still-waiting request. A committed grant wins a concurrent cancellation/deadline and is returned to the caller, which must explicitly end it. In particular, retrying an already granted request cannot revoke it, and `timeoutMs: 0` allows an immediately available grant. Registry contention has a separate bounded transaction timeout; cancellation is observed between transactions.

Each tool integration must:

1. Verify its final resolved worktree generation and UDID against the lease with `startCall` before producing any device side effects. A `false` return means another call is in flight; wait or cancel without executing.
2. Keep the lease across related tool calls and analysis pauses. `finishActivity` ends one activity, not the operation.
3. Register any helper before spawning it, using `registerHelper` tied to the owning in-flight call. That call may register its helper while closing so end cannot overtake already admitted work.
4. Call `finishActivity` only after observing that the activity's side effects and child work have stopped and required evidence is saved. Recording a PID is diagnostic information, not proof of termination.
5. Explicitly call `end` after the entire operation. It rejects new calls immediately and releases only after all tracked activities finish. The session process may remain alive throughout handoff.

Activities have runtime ownership and cannot reuse a completed activity ID. A repeated finish is idempotent and cannot erase later activity. The first implementation serializes calls; helpers can remain alongside later calls in the same operation, so integrations must classify helper interference before enabling device operations.

`block` fences an uncertain operation. Neither PID death, file age, a disconnected caller, nor expiry of the registry transaction lock releases a held operation. Even completing all tracked activity does not automatically unblock it. There is no recovery override in this slice. Callers must retain credentials/request identity after uncertain transport failures and retry or inspect status; they must not infer that a failed response means the operation was not committed.

The token is omitted from `getStatus`, and it must not be stored in shared session defaults. This is a coordination contract for cooperating participants under one OS user, not a security boundary against that user reading or modifying the private registry. Direct device tools and participants using another registry are outside the guarantee.

## Validation

Run the focused suite with:

```sh
npx vitest run src/resource-management/__tests__/manager.test.ts
```

It is included by the default unit configuration. Tests use private temporary directories and injected Git discovery. IPC workers are real Node processes loading this checkout's TypeScript through `tsx`; they do not invoke Git, Xcode, Simulator tools, or installed MCP servers. Each worker receives its isolated state root explicitly, and teardown waits for worker exit before removing owned test directories.

Tests cover cross-process arbitration, live-session handoff, shared-token call serialization, end/call races, queue order, independent devices, binding uniqueness including UUID case, retry identity, aborted waits, grant/abort ordering, delayed activity completions, capacity, corrupt records, and worktree replacement/relocation. Helper and owner-death tests validate durable ownership records with live/killed Node workers. They do not prove termination of real build, debugger, recording, or log-helper process trees.

The additional gate tests cover effective defaults, public credential/target schemas, call serialization, end races, observed command completion, swallowed execution errors, retained open streams, and nested-workspace socket validation. Transport tests run two independent stdio MCP servers, CLI command registration, and a Unix-socket daemon with the real management handler and injected Git discovery. They use a controlled catalog rather than built-module discovery. Built manifest/importer and actual device-handler integration require a separate injected validation after building; the unit transport fixture alone does not prove that wiring.

Provisioning tests cover persisted retries, specification conflicts, invalid/duplicate UUIDs, worktree replacement during creation, independent processes contending for creation, unrelated lease progress while creation waits, and a killed creator with an aged reservation. Creators are injected; no test creates a real device.

Adapter tests cover explicit command arguments, unavailable specifications, rejected/uncertain/invalid creation results, pre-existing UUID rejection, missing or changed bound devices, verification before binding publication, and schema-valid public success/failure output. All commands are injected. Built entry-point checks separately validate actual manifest imports, MCP registration, CLI argument parsing, and daemon invocation.

Next slices must add background process supervision/reconciliation and retirement dry-run. A live MCP validation on 2026-09-17 provisioned and booted a dedicated iPhone 18 Pro running iOS 27.0, ran CalculatorApp tests with 54 passed and 3 intentional fixture failures out of 57 executed, verified managed shutdown through the CoreSimulator catalog, and released the operation. A subsequent MCP session acquired and released the same device, confirming session handoff. Real process-tree cleanup has not been validated.

Live UI validation found that AXe 1.8.0 matches uppercase CoreSimulator UDIDs case-sensitively. The AXe command boundary now converts the UUID to uppercase; the registry and runtime cache retain their existing normalized identities. Local source runs need the pinned AXe binary and its frameworks, just as packaged installations do.

Managed launch tests cover explicit credentials and bundle IDs, literal launch arguments, environment normalization, preflight failures, process/response uncertainty, shared-token serialization, and successful/failed launch during closing. The ordinary launch tests remain part of the affected suite. All commands are injected.

Managed UI tests cover fresh-ref remapping, hash-matched captures, operation handoff, intervening runtime activity, relaunch and UUID casing, input sequencing, uncertainty during focus/post-action capture, safe domain errors, missing dependencies and closing. A separate built-entry validation uses an independent Node process to verify reference isolation and durable invalidation, alongside MCP, daemon and CLI calls. All device commands are injected.

Managed build tests cover explicit source and scheme inputs, required operation credentials, rejection of non-empty extraArgs (including inherited session defaults), buildForTesting, testProductsPath, and preferXcodebuild=false, exact destination binding with bound uppercase-normalized UDIDs against uppercase catalogs and case-sensitive executors, physical device ID case preservation, xcodemake probe and execution bypass under supervision, lease retention across successful builds and confirmed compile failures, blocking on uncertain process termination or open streams, pipeline log descriptor closure upon executor rejection, closing operations held until execution drains, and admission-time UI snapshot invalidation. All commands are injected.

Managed `test_sim` tests cover explicit source and scheme inputs, required operation credentials, wire-format `testRunnerEnv`, safe test selectors, rejection of simulator names, prepared artifacts, unsafe extraArgs (including inherited session defaults), `buildForTesting`, and `preferXcodebuild=false`, the two-phase command sequence, phase 2 serialization flags, preservation of configured test-plan repetitions, uppercase UUID destination binding, asynchronous metadata extraction, shutdown and unique-catalog verification, compile-failure behavior without shutdown, lease retention across confirmed phase 2 failures, and cleanup markers. All commands are injected. Live managed test execution and real Simulator shutdown verification are validated above; the live CalculatorApp run intentionally produced 3 fixture failures. Real process-tree cleanup has not been validated.

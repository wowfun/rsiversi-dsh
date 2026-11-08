# Session search compatibility acceptance

The optional `@deepseek-ai/dsh-experimental-session-search` bundle is loaded from
its installed `dsh.bundle.patch`. Its isolated SQLite query service and five
model tools run in the application's Cordis tree. The bundle has no browser
entry; the original workbench renders the resulting tool calls and responses.
Native Session storage remains authoritative through the read-only persistence
contract in [runtime](runtime.md).

Acceptance covers `session_search`, `session_event_search`, `session_trace`,
`session_event_trace`, and `session_event_read`, including persisted and live
history, workspace filtering, exclusion of the caller's performing step,
incremental updates, cancellation, and reopening an index. Installation must
use the published bundle patch rather than a hand-maintained list of plugins.

Performance acceptance compares the original DSH tools and JSONL persistence
with the bridge on the same machine, Node runtime, installed DSH distribution,
and equivalent Session corpus. Report cold indexing, unchanged repeated search,
incremental updates, and exact reads separately. Alternate execution order;
retain individual samples, median, and p95. Each scenario must preserve result
equivalence and have bridge median and p95 no greater than the original. Report
sample count and corpus dimensions; a small fixture does not establish behavior
for a larger corpus. Do not count provider generation, package verification, or
browser startup as search latency.
Distinguish a fresh search index over retained history mirrors from a complete
cold persistence read. For the latter, prepare/export the equivalent corpus in
a separate process lifetime, then start fresh native and original application
processes before the first measured query. Corpus export must not prewarm only
one side's retained Session views. Record the process identities and verify
that the native measured lifetime has not read the target history before that
query. Keep the initial corpus fixed between rounds; report growing-corpus
measurements separately instead of mixing them into one cold-start percentile.
Both sides start with isolated benchmark state. Native outcome receipts must not
inherit files from previous runs: the real Kernel retires published outcomes,
whereas a transport-only probe does not publish Facts. Measure a deliberately
full receipt ledger separately and label its eviction work; do not mix it into
an ordinary fresh-run sample without reporting that state.

Native transport measurements use RSI's Rust start/observe client, including
typed response decoding and validation. Report a Node HTTP controller's timing
separately: its request dispatch scheduling can add latency before the application
receives a request. Keep benchmark control I/O outside the native client's
interval, record both intervals, and retain auxiliary HTTP results with their
actual scope. Browser startup requests must finish or the browser must close
before backend sampling; verify the original workbench separately afterwards.
The native client probe does not by itself measure Kernel admission or later
Fact publication, which still require live Kernel and recovery acceptance.

The direct `ToolExecutionPipeline` comparator in `runtime.mjs` is a component
baseline: it has neither the original AgentLoop nor the stock semantic checkpoint
policy. Its JSONL side does not perform the same persistence work as a complete
DSH Agent turn. Label that scope in every component result; do not treat its
relative timing gate as full-client performance acceptance.

`original-agent.mjs` provides the original execution-chain baseline. It mounts the
installed AgentLoop, Session, JSONL backend, native executor and
`dsh-session-checkpoint-policy`, then loads the published search bundle patch.
A scripted model produces a tool call and then a final answer; the real Agent
owns request logging, tool admission, result publication and the next checkpoint.
Measure from returning the scripted tool-call response to entry into the next
model request, before any audit callback. This interval includes the original
call checkpoint and result checkpoint. It excludes provider generation and
initial prompt admission. It is a backend execution-chain measurement, not a
complete GUI/startup measurement or the optional plugins in the full base bundle.
Native comparisons must cover the corresponding Kernel path and durable result,
not just the application HTTP call. Keep diagnostic component timings separate.

The [`original-web`](../fixtures/session-search/original-web/index.mjs) comparator
boots the installed CLI's shipped Web profile with
its standard Agent preset and the published search bundle. It preserves default
JSONL compression, semantic checkpoints, context producers and browser services.
Only the model endpoint and credential are replaced by a local deterministic
HTTP server; optional telemetry is disabled for the isolated fixture. Both the
original and native paths must include their actual provider codec and loopback
transport. Measure the tool response-to-next-request interval at the local
server, before inspecting durable evidence. Auxiliary title requests are
answered and reported separately. Do not call the minimal Agent comparator a
default-profile result, or replace its retained failing samples with this broader
comparison. Open the original Web client separately to verify rendered results
and cold recovery; exclude startup and those inspections from backend timings.

Before measuring, verify with independent JSONL reads that the call is present
before the tool body and the result is present before the next model request.
Also verify a rejected call checkpoint prevents tool dispatch. These untimed
checks must not add flushes to the path being verified. Use the
original policy's durability barriers; do not manually append call/result events
or replace the Agent with a structural stub. Cold resume must preserve results
without invoking the tool again. These checks use no provider credentials.

A benchmark of an in-memory native transport fixture only measures the adapter.
It cannot establish native Host or browser performance. Full acceptance also
requires real native Session storage, the application tool transport, and visual
verification of the original workbench. Keep these results distinct. Live and
performance runs are opt-in; default tests use isolated synthetic state without
provider credentials. Record platform, source/artifact identity, failures, and
measurement limits with the run evidence.

Native fixed-catalog acceptance validates the current instruction/catalog text
separately from time context. Time inputs may refresh after the configured
interval or a backward wall-clock movement, as in DSH's time-context contract.
The native producer compares its sample with the previous entered input's Fact
timestamp. A refreshed input must appear exactly once in subsequent request
evidence; requests must retain the earlier model-visible context in order.
Do not require a whole run's system evidence to remain byte-identical across
legal time refreshes. The isolated straight-line fixture's
`native-evidence.mjs` checks these cases without weakening latency thresholds.

Resource evidence accompanies native runs: record corpus event count and bytes,
native database bytes, additional application journals, receipt storage, index
storage policy, and process memory where measured. Separate canonical data from
rebuildable projections. An optimization must not hide duplication by adding a
second durable corpus or an unbounded memory cache. Forked histories should
retain the native shared prefix instead of materializing another durable log
merely to make it searchable. Small-device budgets remain workload-specific;
latency alone does not establish suitability for those devices.

The original Web fixture's `append` method updates a cold source through the
installed JSONL writer, flushes it and reads it independently before returning.
Its test verifies a previously populated index finds a new unique marker and
that repeated appends preserve the old prefix. This is original-client fixture
coverage; it does not establish native incremental performance.
Full native incremental comparisons must also match source availability. A
native prompt may retain a live Session whereas a JSONL-only append leaves an
original source cold. Do not erase the returned availability field to make these
different cases compare equal. Resuming an original Session appends its own seed
marker, and Agent initialization can append policy events; it is not a pure
cache warmup over an unchanged corpus. Record preparation reads and lifecycle
changes outside timing, preserve the prior prefix and require the new marker to
be found. Do not edit the native database or fabricate its canonical Facts.

For the unseeded live-source case, `append(..., {live: true})` also publishes a
read-only actual DSH Session into the original registry. It constructs an empty
detached Session and replays the independently read JSONL events with the public
append API. A synchronous fixture clock supplies each recorded event time and
is restored before any await or publication. Full event equality is required
before entering the Session; no constructor seed, synthetic resume event,
original Agent or second durable writer is introduced for the source. A later
append detaches the old read-only view first. Query execution still uses the
stock original Agent and query engine. Replay and log preparation are outside
query timing; this fixture does not establish cold-history performance.
For a forked live source, the independently read log must already contain its
child-owned inherited marker at the recorded cut. The fixture passes the complete
log, header and inherited count to the original `Session.create` snapshot API.
That public constructor preserves an already marked fork without appending a
resume marker. Require exact header, inherited count and event equality before
entering the read-only view; do not change the fork boundary or duplicate a native
durable prefix for this preparation.

Run the installed-package contract test with `RSI_DSH_MARKET_COHORT` set to a
directory whose `node_modules` contains the DSH distribution:

```sh
node --test packages/rsi-dsh-plugin-bridge/test/workbench/workbench-session-search.test.mjs
node --test packages/rsi-dsh-plugin-bridge/test/workbench/original-search-agent.test.mjs
node --test packages/rsi-dsh-plugin-bridge/test/workbench/original-web-search.test.mjs
node fixtures/session-search/benchmark.mjs .local/session-search-adapter.json
```

The benchmark command alternates five paired rounds over 128 Sessions and 8,192
events. It retains samples and exits unsuccessfully if any adapter scenario
misses the relative median or p95 requirement. Its native callbacks are synthetic;
it must not be reported as the full Host acceptance.

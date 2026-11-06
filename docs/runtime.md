# Runtime contract

The Cordis package owns process transport, release loading and package archives.
The bridge composes these in its application entry. Session history and native
commands, workbench services, tool execution, and market installation have
separate module owners. A packaged application carries the runtime modules and
brand assets it executes. Its process descriptors resolve those modules inside
the selected payload. In the Agent extension, Session loading and eviction
share the same canonical mirror used to accept or undo staged Agent operations.
The market's desktop pnpm and Plugin Manager invocations operate on the same
profile selection journal and live package bindings.

The market dispatches `agent/turn-stopping` serially on the producing Agent
after its Step has settled and before its Turn ends. Listeners read the
settled Session and can steer through the normal inbox. The reply waits for
those publications so the native Executor can admit them in the same Turn.
While the producing view is retained, a read-only outcome request can observe
the existing preparation or stopping promise, including a plugin rejection.
Releasing the view ends that recovery window. Tool body receipts have their
own durable lifetime.

Verbatim file prompts use the original `fileUploads` receipts and binding guard.
The bridge resolves receipts against the uploading Agent's exact Session,
commits their binding only after native mailbox acceptance, and rolls back a
failed submission through the original guard. Native input, hook decisions and
projected history retain the file digest, filename and length. No file bytes
cross the application IPC. The generated market Profile installs the ordinary
`rsi.media.attachments.local` reader over the original attachment namespace. Native
Session admission verifies the object, and native providers emit tool-readable
handles. The reader also supplies the original normalized image objects to
native Media using their published digest, MIME type, byte length and
dimensions. The original attachment store owns decoding and normalization.
The HTTP carrier releases an unread request body after a handler returns and
lets Node discard remaining transport bytes. Early upload rejection must not
leave a backpressured body attached to a reusable connection or destroy its
response socket.

Market profiles use the published DSH runtime's version and public package
exports. The workbench uses the DSH 0.2.2-rc.1 Session contracts and the
Cordis range declared by its host. Source revisions and
archive digests identify test inputs and installed bytes, not a compatibility
allowlist. Resolve peers strictly using DSH app-boot's prerelease semantics
for host-provided DSH peers. When npm would exclude such a peer, the plugin
binds it to the selected host version. The published-release fixture uses the
same rule and the requested host's declared Cordis dependency range.
Share the runtime's physical Cordis, React
and DSH service identities. Keep the plugin's own dependencies private where
their ranges or module identities differ. Registry resolution runs with scripts
disabled. The market reads the original Plugin Manager's per-dependency
allowBuilds decisions. An undecided build reports the dependency to that
manager before publishing a selection. Only explicitly approved, resolved
private package instances are rebuilt in staging. This executes code with the
local operator's permissions, including on Windows. The installer gives the
child a private npm home and no Service credentials.
Bare imports prefer the importing package's declared dependency and nearest
profile package. A missing profile package can resolve from the initial host
graph through its public Node exports. The published market uses this for its
computed Cordis Include import during hot activation.
The selection payload includes the bridge's complete local module graph, so its
application and history entry points load without access to the source checkout.
The workbench mounts the release's original Cordis host runner alongside its
client runner and panel. Their inventory and inspect-manifest calls use the
original Typert service; the bridge does not emulate an empty successful reply.
The original browser Connection entry uses RSI's authenticated carrier. Its
host row depends on the running connection service. Listener flags and trusted
hosts belong to the launcher that opens the listener.
The original Typert Loader belongs to the base workbench, independently of the
optional registry importer. It registers mounted packages' published `./typert`
contracts for the Gateway, including the native Session and Workspace adapters.
Profile context, ConfigEditor, Settings and the published Settings controller
also belong to the base workbench. Forms edit the running plugin's volatile
Config through the original profile patch and survive reopening. The optional
registry importer adds package installation, not configuration ownership.
The Settings controller keeps DSH's explicit missing-provider error for a
credential service that the composition has not selected. Local application
discovery and opening use the original `dsh-host-open-in-app` routes and
subprocess provider, with the same authenticated browser carrier.

A profile owns one application Cordis root and one loader. A mixed plugin
registers its routes and tools in that tree, sharing one instance of its
state. When the service profile selects application tools, each Kernel
Conversation request captures the application's own DSH registry. The capture
also invokes original `systemPrompt.assemble` with that same selection,
Agent scope and resolved Tool set. `renderPrompt` supplies native current Step
instructions through the same capture reply; retries do not reassemble it.
The retained capture also owns the `agent/pre-step` message waterfall. Preparation
uses the same Agent, resolved Tool set, assembly and model selection, with the
native final claim batch. It runs once per view; an uncertain response does not
authorize another callback execution. A system section is not converted to a user
message. Dynamic runtime-context projection follows the committed Session surface,
so retries and failed publications do not advance its baseline.
The waterfall receives user-role inputs. Native developer guidance keeps its
slots around that ordered result; removing all originally claimed user inputs
also drops guidance instead of starting a guidance-only request. Original object
identity or an unambiguous original message ID preserves a claim coordinate.
An ambiguous cloned ID is additional input, not invented claim provenance.
Preparation admits 97 MiB of request JSON for the native 32 MiB mailbox prefix,
16 MiB of contributions, 16 MiB of Tool contexts, a 32 MiB preceding decision
and framing. Only unchanged claims in a preceding decision need their original
bodies. Its reply uses
the 36 MiB native Fact envelope around the 32 MiB final-list budget. Other Tool
operations retain their smaller envelopes.
Native input claims do not append conversation messages. History mapping version
4 retains their Fact coordinates until `step_inputs_prepared` supplies the final
ordered list. Only that list enters the DSH surface; replacement, omission,
reordering, repeated coordinates and empty message bodies preserve their native
meaning. Rejection clears the claimed set without opening a DSH Step. An initial
empty list also opens no Step. Terminal cleanup discards unprepared claims.
Mapping checkpoints retain coordinates, not copies of message bodies. A live
projection shares immutable captured Facts across branches; cold replay resolves
each needed Fact once from the captured history. No old mapping-version fallback
is provided. Preset contributors and the application edit one ordered list.
A rejection ends preparation and commits the staged plugin changes. While an
authored conversation reference awaits publication, its DSH text contains the
captured source and preview. Editing adjacent text preserves the structured
reference. The committed projection adds the exact native `reference_read`
coordinate.
The preset keeps priority for existing names. A retired registration cannot dispatch
a captured call to its replacement. Application Tools follow native Turn and Tool
policy without an additional approval solely for plugin origin. The original DSH
pipeline owns pre-execute policy, approval, guards and around-execution hooks
in both the market and Agent adapter. An admitted call enters that pipeline
with its logged arguments. A hook can deny the call or answer it directly.
When it delegates, the registered tool owns input validation at its body
boundary. DSH validates successful body and hook values against the tool's
output schema and finalizes errors through its normal result hooks. Native
wire decoding owns its envelope and retained-content bounds.
These trusted plugins run as the local operator, independently of native process sandbox
settings. The published loader handles ordering, conditional
rows, groups and reconciliation. Failed activation releases the root Fiber and preserves
the original diagnostic. A registry install and a profile enable are distinct
operations; the market's request specifies which to perform.

The market workbench mounts the release's local subprocess service, sandbox,
sandbox policy, platform shell and shell environment registry. Installed plugins can use `ctx.shell`
without registering another model tool. Claude Code and Codex command hooks
use their own config files, stdin dialects and result decoding. They run in
the Session cwd and use the DSH deployment policy, as the published hook
runner supplies a working directory without a per-call sandbox policy.
The default deployment write root for such calls is the profile's private
`shell-workspace` directory. Set the original `sandbox-policy` row's
`workspaceRoot` to the project when hooks need to write there. A provider
that passes a Session to the policy service gets its Session workspace.

The DSH standard preset's model tools are `@deepseek-ai/dsh-tool-pwsh` on
Windows and `@deepseek-ai/dsh-tool-bash` on Linux. A market profile can
enable the corresponding Cordis entry. When the native preset also provides
`bash`, list `bash` in the Host application's `replace_preset_tools` to
give that name to DSH. The workbench mounts the release's host-wide
`dsh-jobs-local` registry. To run a standard shell command in the background,
enable its preset's `dsh-tool-jobs` entry and assign `job_list`, `job_output`
and `job_kill` to the application when the native preset supplies those names.
The Session's Cordis Agent owns the job until disposal. The workbench checks
the browser's native Session access when opening a job stream or stopping a
job. The release controller then enforces job ownership and reads retained
output independently of the model's cursor. The live registry lasts for the
application process. The DSH minimal preset instead composes its
persistent shell tool with a private terminal registry and platform backend.
To exercise both compositions, set `RSI_DSH_MARKET_COHORT` to the absolute
path of a release npm installation for the current OS and run
`node --test packages/rsi-dsh-plugin-bridge/test/workbench/workbench-shell.test.mjs`
from the repository root. Run it once with native Windows Node and once
with Linux Node and a Linux-native release installation. The standard tool runs
under the release's `workspace-write` policy. The test checks that a relative
`workdir` can write inside the Session workspace, that a sibling write is
denied, and that the next command starts in the Session cwd. It also checks
foreground exit status 7, background output and cancellation. Cancellation of
an executing foreground or persistent command must settle through the same
application receipt. A subsequent command remains usable; the release's
persistent tool resets its terminal on cancellation, discarding shell variables.
A fixture Mod runs in the release Claude Code Mods engine and reads the calling
Agent's restored messages before deciding whether to run the standard shell.
The test checks the application tool receipt and the contents of the shared
workspace for both decisions. Two Agents sharing a working directory keep
separate persistent shell environments. A new tool selection for the same Agent sees
its existing environment. The standard Bash and PowerShell tools attach
the resolved working directory to their result event, including when a
command exits unsuccessfully. The minimal preset's persistent tools leave
that field absent. The [Session journal](session-journal.md) owns this mapping.

Application opening uses protocol 9. The native Host supplies an opaque `owner`
callback whose identity is the shared browser owner and whose lifetime is the
selected application process. Explicit background activities run through this
callback; HTTP handlers retain their own authenticated request scope. An activity
drains its ordered native writes before resolving, including during teardown.
The first rejected write stops the remaining writes and fails the reply, even if
a Cordis callback rejects with a non-Error value.
A resident observation retains the caller and cancellation lifetime without
holding one publication open forever. Writes scheduled by its notifications open
finite owner activities; per-Agent ordering still applies. Their lifetime is
independent of a browser or a cancelled read, and Agent disposal drains accepted
writes. An owned publication drains writes staged by its earlier writes until
the chain settles; it has no arbitrary cumulative write-count limit. A
notification after an HTTP reply has been sealed opens a new owner publication.
Direct request staging after reply publication is still rejected. One failed
notification write does not poison future notifications. Application shutdown
cancels and drains observations and writes.
A browser disconnect does not dispose application-owned work. Application
shutdown drains Cordis plugins while their native caller remains available for
teardown, then closes background admission, cancels reads and drains active work.
No callback grants local-only native administration.
The Session controller's catalog observer runs under that owner, independently
of open transcripts. It subscribes before listing drafts and published Sessions.
Native changes, saved titles and Agent availability refresh the catalog. Changes
coalesce during capture. The observer emits the release's ordinary added, removed,
status and activity events.
The listing's running flag reflects resident native work. A cold Session with
unfinished history remains visible alongside other Sessions.
An application-created fork retains its declared DSH origin and delegation
depth with the native seed's parent. The original Session Title service
appends titles to the application journal. A compact prefix in the same
atomic document supplies the catalog's cached title and its event sequence.
The workbench's `session/rename` resolves the requested Session and passes
the proposed title to that same service. Its reply carries the accepted title
and the sequence of the user-authored title event. An invalid title yields
`session/title-invalid`. Other workspace windows and a cold catalog read
observe the saved title without opening the conversation.
Catalog reads match the native creation time and reuse the prefix between
updates. Opening another browser can discover these threads without a
remembered ID. The native fork retains its independent execution lifetime.
A failed catalog read preserves the last complete view and retries; it never
turns a partial or unavailable read into removals. Listing starts no Agent and
reads no transcript. The observer stops and drains with its Cordis owner.

Workspace followers share the application change signal. Each reads its own
authorized baseline before emitting the original Workspace frames. Registration,
Navigation metadata, grants, drafts and durable Session changes wake followers.
An idle standard Host samples in-process revisions without periodic directory IPC.

The automation page uses the release's Schedule service and its ordinary
storage, JSON backend and storage-domain plugins. Schedule records live under
the selected profile's persistent state. The original service owns its timer,
catalog, delivery history and Workspace archive listeners. When a reminder
comes due it resolves the target Agent and waits for the native Session write
before acknowledging delivery.
The bridge submits an original `user` message as user-initiated input. A
reminder wakes the same Session with native application provenance and keeps
the release's message ID and `schedule` source in its presentation attribution.
If the native submit handler returns an error, the bridge checks the original
message ID. A committed input keeps its receipt. A confirmed refusal retires
the local insertion before the producer retries. A lost transport reply leaves
the original ID available for reconciliation.
The market Host assigns the preset's reminder tool names to this application.
Model calls use the original Schedule tools and the same store as the page.
Only the names offered by the selected release appear in a model request.

The original Workspace archive and unarchive commands share Navigation's durable archive order. Archive combines the Cordis `workspace/session-activity` waterfall with the native activity families supplied by Serve. Within each family, plugin labels take precedence for IDs also reported by the native host. A native background Job uses its original executor label and stops when its owning Turn is cancelled. An active Session produces the original `workspace/session-active` error with its activity list. Confirming skips this query, persists the archive and pin removal, then dispatches `workspace/session-stop`. The live Agent registry cancels its own Turn. Serve stops active native subagents even when the parent is idle and handles a root Turn without a running Agent mirror. Provider failures leave the archive durable. A repeated archive skips providers. Restoring also succeeds for an absent or already restored ID.

Workspace pin and unpin commands on published Sessions change the shared native
Navigation metadata. Their replies and the Workspace feed carry the caller's
visible pins in most-recently-pinned order. A repeated command preserves both
the revision and the order. Archiving a Session removes its pin atomically.

The original Agent registry has a native-backed factory. Opening a workbench
transcript attaches a live mirror without waking a model. Listing remains cold;
sidebar reads refresh existing Agents and leave unattached side conversations for
the caller's resume setup. Owned Agents and their working directories remain
accessible outside a browser request. Each mirror reads history and
pending input at one native cut: durable inbox cursors bound replay; draft
revision changes cause a fresh capture. The registry's caller Cordis context owns
setup, publication and disposal. A created side conversation uses an independent
native manual fork at the supplied history cut, not a Kernel-owned child.

An attached Agent observes native history and the native model stream under its
application-owned lifetime, including while no browser is open. It publishes
the original scoped `agent/assistant-stream` start/chunk/end contract. An
attachment or read reconnection inside an attempt replays its retained prefix
before subsequent chunks. Revisions increase throughout that Agent lifecycle;
chunk positions are dense within the attempt. Stream frames are transient and
never appended as synthetic Session events. A committed end follows publication
of its actual assistant event; read failure or disposal abandons the live
attempt and clears plugin buffers. The workbench and Agent use the same native
stream conversion, including the final chunks when durable settlement wins the
race against an outstanding stream read. Closing an observer releases its read
resources and does not cancel execution owned elsewhere.
Resource close calls use the same native request identity but do not inherit a
cancelled read signal. Only model/seed resource release has that cleanup path;
ordinary reads and writes retain their activity's cancellation.
The native create seam accepts the existing `ForkPoint` (`before_turn` or
`through_turn`); selecting a before point never waits for or interrupts its
source Turn. A seeded open Turn selects its canonical before point and converts
its actual user text, assistant text/reasoning and tool activity to bounded
reference text. Synthetic terminal markers never become native Facts. The
native context-seed command holds this supplement outside the inbox and enters
it once with the first request. Only observed reasoning is included; executing
tools are labeled as such, with no claimed result. The snapshot retains at most
8,000 UTF-16 code units, with explicit truncation, and 2,000 per tool result.
An empty native prefix selects before the source's first local Turn. When a
plugin already truncated its open tail and supplies its own snapshot through
inject, that original input remains the snapshot owner.
Inject submits native non-waking `NextStep` input with ordered native content
blocks and presentation attribution (`id` and `source`). Text and verbatim files
use the same conversion as waking submissions; native admission verifies file
objects before publication. Native pending and
consumed history readers expose that original message while native message
identity remains the key for receipts, queue mutation and transition correlation.
This survives cold replay and inherited history without a local metadata map.
Followup submits a human
message with its original identity. The HTTP publication boundary waits for both
receipts. Finite sidebar requests for overlapping Session identities serialize
capture, handler and publication so a concurrent first contact sees the previous
committed inbox. Agent void mutations outside a live request use the application
owner, retain per-Agent ordering and report asynchronous failures to the application
logger. Plugin timers therefore need no browser callback. A factory handle stops and drains its Session's driver and
releases its scoped registrations; an automatically attached parent mirror does
not own or cancel native Headless work.
Owned Agents observe native history changes independently of browser requests and
emit the original `session/event` notification for newly projected committed
events. Published Sessions wait on native Fact/control cursors; unpublished drafts
wait for native revision changes until publication. Disposal cancels and drains this observer.
Tool capture ensures an attached Agent and its exact scoped context, including
setup registrations, even on first contact from native execution. The tool
callback owns an application activity and drains native writes before publishing
its result. Opening the mirror does not wake another model request.

Attached `Agent.whenIdle()` first drains accepted application writes, then waits
for native driver quiescence and refreshes the shared view. It follows a newer
accepted publication before resolving, including work started by its refreshed
event observers. Overlapping callers share one pending convergence promise.
Factory disposal uses the same native idle wait after Session cancellation;
it has no polling timer or repeated full-inbox capture. A held or paused inbox
does not by itself keep the driver active. The wait does not reserve future idle
state, identify a particular message receipt or wait for unrelated descendants.
Agent status and inbox/assistant notifications use the original DSH fused Agent
dispatcher, with the same subject and a carrier allocated once per attached
Agent. Status changes follow the observed native driver state, including queued
waking input and activation cleanup. A throwing Agent notification listener
cannot suppress later listeners or turn notification failure into execution failure.

Inbox remove/clear synchronously select currently displayed pending identities.
The mirror hides those identities while ordered native withdrawal is pending;
it is an intent projection, not a second execution queue. HTTP success waits for
the real native result. A claim race fails publication and recaptures the queue
without cancelling the claimed Turn. Draft inputs use native identity-based
withdrawal, with no fabricated durable slot or cursor. An empty clear remains
a no-op. Writable Session log events still require their own native contracts.

Durable inbox transitions replay as original `agent/inbox/spliced` Session events
at their native Fact/control anchors. Accepted message bodies use the existing
fragmented native read boundary. Pending arrays follow the native inspection's
acceptance order; claims, promotion and discard update that same projection. A new
child replays only its own inbox controls, so inherited pending work is not copied.
Queue-only changes advance the real projected event log and notify ordinary
Session observers. Draft intents remain outside that durable event log.
The inbox fold associates each Agent notification with its application event
position. Publishing a batch consumes those positions in order, including a
native claim of an input that was already withdrawn locally.
All events count toward the mirror's 64 MiB retained-log budget. Individual
inputs use the native admission bounds; the workbench imposes no additional
per-event size limit.

The optional tool listener uses a separate authenticated loopback port inside
the application Worker. A capture retains the original resolved tool set for
one native request series. The DSH registry owns registration, activation
and withdrawal. An admitted native body belongs to that invocation's DSH
execution source. Public registry lookups made by hooks still see the actual
registered plugin, including when it has the same name as the native tool.
A started invocation is bound in memory under its native
Session and effect before entering the original pipeline. The native Tool intent
owns durable admission; the application persists only settled results. Protocol 11 keeps
the initial start request open and returns the committed JSON snapshot after
the atomic outcome write. A repeated start for the same retained invocation returns its
recorded state. A read of its outcome never dispatches the tool. An interrupted
body without a recorded result reports uncertainty. Reads and cancellation bind to the
original registration and native Tool result identity, including the caller's
argument digest. A cancellation arriving during admission waits for that ordered
admission before deciding whether the body is running. Lost HTTP responses are followed
only by outcome reads on the current or replacement process. A new execution requires
the original live captured view and registration; duplicate start may read an existing
matching receipt without that view. Missing receipts in a replacement process remain
unknown. At most eight calls run at once. Pending and unknown live bindings share the
128-record retention limit with settled files; only settled files count toward the
64 MiB disk budget. Identity fields follow the native 256-byte identifier bound.
When the application retires, a call still awaiting admission cannot
enter the plugin body. Retirement cancels bodies already running and waits for
their final receipt writes before releasing the captured tool sets.
Market tool hooks return text `additionalContexts` through this receipt.
On success the same receipt preserves the original pipeline's `concludesTurn`
marker. The native Executor decides at the batch boundary whether pending input
needs another model request.
When policy prevents a native body from starting, the refusal frame carries
the original pipeline's final deferred messages. The Kernel records them with
the model call's rejection and claims them on its next preparation.
Capture requires the actual native request's `modelSelection` and passes it
unchanged to the original resolved-tool registry. Model-aware activation therefore
uses the same provider, model and effort as the following provider request. It
does not read an Agent's potentially newer selection or substitute Header defaults.
RSI commits the context messages with the tool outcome and projects them
into the next Step after sibling tool settlement.

The original Session controller's `modelCatalog()` groups the native model
routes by deployment. The workbench and Better Sidebar's Side Chat use the
same catalog, including the actual default route and provider-supported
reasoning effort IDs.

The application and Agent adapter expose the native Session directory to DSH
plugins through `workingDirectory.get` and `ensure`. A market tool hook owns
its captured Agent and Session only inside its execution scope. A sidebar
request can resolve its authorized Session. Setting an equivalent directory
returns the existing cwd. Changing native Session coordinates requires a new
Session.

The workbench presents a followed root's pending human interactions through
the original DSH Remote Event waterfall and client cards. Authenticated browser
windows share DSH's owner Peer. An approval displays the native
arguments, workspace and sandbox. An explicit allow or reject goes to the
native caller-bound Session. A lost view leaves the question or approval
pending for reconnection. Concurrent views of one root share its observation.
When one view closes, another supplies the physical request for the same
pending interaction. Any connected owner window can answer once.

A history follow is passive by default. Once the native opening snapshot is
available, an explicit `activate: true` on a root starts a missing Cordis Agent
under the application lifetime. Delivering history and observing interactions
do not wait for Agent startup. Activation errors reach the release's
`api-session/error` event.

A plugin waiting for services reports the missing names from its Cordis
Fiber's resolved injection contract and scope. This diagnostic is evaluated
after loading, so services registered earlier in the same profile participate.

Shared runtime objects and plugin payloads are leased independently. Layout
metadata locates ordinary packages and their peers under those leases. Retain
the existing per-tree file and byte limits, and partition on npm package
boundaries when needed. An npm working tree or cache is never a runtime
authority. The source-built Agent profile described below has its own
package selection and process lifetime.

The host uses an installed Node >=24.9. An explicit executable takes precedence
over PATH discovery. Launches use the actual executable, never a shell shim.
The plugin does not download Node. Original packages are trusted native code;
Node builtins are available and this process is not a sandbox.
The host checks its own runtime version before loading plugin code, including
when an explicit RSI preset bypasses Node discovery. The reference source
producer can build a checkout, a modified source tree or an archive. Only a
clean checkout can reuse packed artifacts. Reuse checks the source revision,
lockfile, build script, Node, installed build tools and the cached tarball's
digest. A source change or missing Git metadata triggers a fresh build.

The generated Agent preset puts the process and adapter under one Profile group
with fresh Local isolation for `rsi.extension.connection`. Registering a Local
marker makes the name resolvable; it does not allocate a private slot. Fresh
drafts, restored Sessions and fork preparation can need different generations
at the same time. Each pair must resolve its own connection.

One process belongs to one Agent generation. Old and new generations may
overlap. Host and child use bounded, generation-fenced, bidirectional requests;
waiting for a user answer does not hold the reader, writer or Session mutation
lane. Cancellation replies use the same correlation identity. Loss of a process
does not authorize replay of a callback.

The standalone Agent importer packs the shared peers actually installed in its
leased host cohort: `@deepseek-ai/*`, React, React DOM and Zod. It does not use a
source-revision package inventory, and resource-only packages need no JavaScript
entry point. Other dependencies are resolved by npm from those packages' current
manifests. Shared peers, including
Cordis and UserQuestionError, resolve to one exact physical cohort. Private
ordinary libraries may have multiple versions. Import uses a pinned npm CLI,
isolated configuration/cache/home and explicit registry settings; lifecycle
scripts and bin links are disabled. RSI PackageStore is the installed registry
and owns immutable payload leases. Import success is not compatibility evidence.

The generated market profile and npm child use the selected credential-free
HTTP(S) proxy and bypass list. With a proxy selected, Node also routes native
fetch through it, including requests from the original Discover plugin.

The bridge's `import` export handles registry specifications, local npm tarballs
and built package directories through the generic RSI importer. It stages a new
`dsh-import-*` package with a complete private peer cohort, an exact dependency on
both implementation packages and a `process` export. Its `plugins.json` selects
the imported server plugins with their default configuration. A preset selects
that process export and pins the generated manifest digest; installation never
enables code or edits a user's presets. Browser code still requires an explicitly
rebuilt document. Unsupported injected services fail activation; unknown event
schemas refuse history-window forks. No universal plugin compatibility is claimed.
The import receipt records the running DSH and npm versions and the resulting
npm lock digest. Its temporary installation is removed after payload publication
or failure; the staged RSI package retains everything needed for execution.

Fresh release builds and plugin imports ask npm to prefer a shared dependency
placement when the declared versions and peers permit one. npm records the
actual placements in its lock. Packaging an existing installed tree preserves
that lock, including multiple versions or peers that require separate instances.
The release importer seeds its npm stage with the selected runtime packages
declared by the requested plugins. npm resolves the remaining transitive
dependencies. Edges into the admitted runtime reuse its selected graph. A
market install therefore does not need to reinstall the DSH umbrella package
unless the plugin requests it.
The bundled npm resolves in an empty work directory with an explicit registry,
private home/cache and empty user/global configuration. Pinned original packages
are supplied as local archives from the leased cohort. Imports cannot replace
them. Packaging checks their complete files; nested copies of a shared peer are
rejected after installation. The importer checks the original engines.dsh rule
first, otherwise the DSH peer ranges, including prereleases. npm receives the
same prerelease peer overrides as the release importer. Its tree reader caps
files at 16,384, total entries at 65,536, path depth at 128 and total bytes at
4 GiB; file content is read in bounded chunks. The recorded npm lockfile binds the resolved dependency tree;
Git/HTTP dependency specifications are refused at every depth. Local tarballs
and directories are admitted only as explicit root inputs, including the pinned
archives. Lifecycle scripts, executable links and filesystem links are refused. Build-required packages must be built before import. This
retains native-equivalent trust: disabling lifecycle scripts is not confinement.

The two RSI format-2 packages are separate immutable payloads. The Cordis package
owns the host, pinned npm CLI and original peer cohort. The bridge package declares
its exact Cordis manifest dependency and exports a generic process descriptor.
The host passes its cohort loader to the bridge, preserving one peer graph across
the physical package boundary; the bridge does not install another dependency tree.
Process descriptor version 1 and Agent bridge protocol 3 are install-time
requirements. The selected Node executable and environment remain explicit Host
configuration, outside the package descriptor.

The bridge Session facade has stable identity within one healthy incarnation,
contiguous sequences, synchronous append and projections. It has no independent
database. A mutation stages a bounded suffix and domain replacement for an RSI
Tool-result, Command or BeforeStep commit. Only the matching canonical receipt
confirms it. Definite rejection discards the suffix and retires the incarnation;
uncertain commit stops mutation until canonical reconciliation. Callback replay
is forbidden. A flush fences only the canonical prefix; waiting on a callback's
own uncommitted suffix is explicitly unsupported.
Within a healthy incarnation the committed prefix is an offset in the immutable
Session log. A receipt advances that offset and publishes the staged projection.
Rollback, fork and explicit export can materialize the prefix on demand.

Tool hooks can attach ordered DSH user messages for the next Step. Both
adapters return their IDs, sources and text blocks in the native ToolResult.
BeforeStep passes the captured messages through the original pre-step waterfall.
The standalone adapter uses its captured Fact history and any earlier preset
decision. The resolved native model and effort are passed to Tool selection,
prompt assembly and the waterfall. A hook returning reject stages its journal
effects without adding runtime context.
For a resident durable Session, the caller presents its immutable header
coordinates, positive journal revision and event count before restoring history.
A quiescent matching mirror keeps its original Session object. A missing mirror,
changed revision or revision-zero draft receives the native CAS event pages
and then the checkpoint.
The native history records the originating Session, effect and message ordinal.
Forks project the outcomes in their selected history interval. A failed publication leaves the messages pending for the next claim. A committed hook rejection consumes the claim.
The workbench expands a native multi-message entry into one DSH user event
per message, preserving each original ID and the order of its content blocks.

The workbench mounts the released DSH command registry. Its browser command
directory and invocations resolve the addressed Session's real Agent, including
when the first request arrives before a conversation follow. The Session
controller owns the Typert lookup shared by commands and the terminal.
The native actor lookup checks the caller before a resident Agent is reused
or a cold Agent is resumed. Browser command lifecycle events are log-only
entries in the application Session journal and survive reopening the workbench.

The frozen command catalog exposes the original DSH command registry's global
definitions. If a name does not fit RSI's 64-byte lowercase/digit/hyphen Session
command grammar, native catalog admission rejects that generation. Commands here
receive text; DSH attachment uploads and per-Agent dynamic catalogs are not
exported. DSH owns parsing, result
normalization, cancellation and lifecycle events, including `recordInput` and
optional result text. Its command-pair ID belongs to the log; RSI's request ID
owns the transaction and receipt. Explicit source-event references are remapped
on a recent-turn fork or the fork is refused when the referenced event is absent.

Todo events settle atomically with the corresponding Tool result. Plan pending
intent is durable bridge state: active, narrate and cause identity. A verified
artifact-hash adapter restores the original private WeakMap. BeforeStep applies
the pending mode, records exact prompt changes and tool subset, and clears the
intent in one commit. Rejected work restores all of these from canonical state.

A human Tool may suspend after observing its fenced RSI Fact prefix, but before
the plugin appends anything or stages an input. Those observations are not a
publication. If another mutation enters while the question is open, it starts
from canonical state; an answer from the displaced mirror cannot commit. The
DSH review identifies the original model call, while RSI routes the question by
the distinct, already-started Tool effect.

BeforeStep reads the captured RSI Fact horizon through an operation-scoped history
port. Its checkpoint retains the consumed Fact cursor and the current Turn/Step
mapping. Lifecycle events use canonical Fact timestamps; restoration adds no
resume markers. A fork projection derives one owned `session/end-seed` event
at its inherited cut from the immutable fork Header, using the child creation
time. Nested forks retain ancestor markers and add their own final marker. This
is the DSH view of native lineage, not a new native conversation Fact. The mapped
`turn/start` drives the original Todo reset.
An RSI Step can contain several model requests: the DSH step counter advances
per prepared request, while the RSI acceptance identity remains unchanged.
Conversation ModelIntents map their actual route, effective reasoning effort,
sampling controls and complete JSON Tool schemas to DSH request headers. Referenced
evidence is read from the same captured Fact authority and checked against its
original inline digest; missing evidence fails the stage. History reads carry their
captured horizon and consume bounded contiguous Fact pages. Inherited reads use
the same page contract within their retained native interval. Evidence references
to a Fact in the current decoded page borrow that Fact instead of issuing another
read. No extra durable copy or cross-page cache is retained. Retries with unchanged
headers do not invent a new series. Compaction calls do not update conversation
mode narration. DSH cannot represent hosted/freeform tools or RSI-only sampling
controls in an EpochHeader; these fail explicitly instead of publishing a partial
header. Each model-attempt Fact carries `attempt: {retain_context, events}` from
RSI's canonical decoder in the same captured page. Encoded attempt chunks and a
second attempt-read callback are absent. Agent extensions require native
`rsi.extension.agent` version 8 for this history view. Their elapsed offsets remain unchanged and are anchored
to the canonical ModelStarted timestamp. Original DSH stream accumulation and
block assembly produce assistant messages and failed-attempt records. RSI's
inclusive input-token total is converted to DSH's disjoint uncached/cache counters.
Unrepresentable model events fail the stage; they are never silently dropped.
Successful attempts produce a message irrespective of the partial-retention flag.
Failed/cancelled/max-token attempts produce a surface message only when RSI retains
their safe text/reasoning prefix; otherwise their stream remains an attempt event.
The DSH surface uses DSH's interruption marker and safe-prefix assembler. It is a
projection for plugins, not a reconstruction of RSI's effective model request:
RSI Context owns its additional partial-output advisory. Provider failure fields
map from RSI's safe error taxonomy, preserving status, retry delay and request ID.
Tool choice `none` omits tools from the header. Non-text response formats and
provider request extensions require an explicit adapter instead of partial headers.
Entered user and developer inputs preserve their role, canonical source and stable
message identity. A dormant empty system head precedes the first input; it denotes
that no request has established instructions yet. Each conversation ModelIntent
replaces that head with its authenticated system evidence. No placeholder is used
as model-request evidence. Native semantic text blocks (`type: text`,
`content.text`) become DSH text blocks (`type: text`, `text`) at this evidence
boundary. Projected system messages must round-trip through the original DSH
Session format, including its JSONL persistence codec.
Tool calls retain the model's raw argument text; only
model-origin outcomes join the conversation, while Program internals stay in RSI
Facts. Denials and terminal/superseded calls carry explicit non-execution or unknown
outcome provenance. Pending call references are bounded and survive restart.
Every resolved model call, including a refusal or a call skipped before dispatch,
has a DSH `tool/call` event and a `tool/result` referencing it. That event records
the invocation, not body execution; native `ToolStarted` alone establishes the
latter. Original cold conversation rendering therefore retains refused calls.
Stored application projections built without those call events cannot reconcile
the changed source prefix. They are not silently rewritten or discarded.

Fork cuts are immutable completed-turn selections. Last(n) preserves the exact
projection baseline while excluding omitted conversation messages. Event schemas
must explicitly declare references before admission. Unknown schemas and invalid
seed versions fail before publishing a fork. A manual fork starts as a draft;
its first input creates an independent execution root with historical lineage.
Turn boundaries carry their RSI Session/Fact provenance. A Last window replays
only selected turns; its seed is the original Todo/Plan projection state immediately
before that window. The active system head and request header may be materialized
as at most two metadata events. Seed rows skip that metadata, avoiding a fabricated
Plan narration transition. Replacements and source references are rewritten only
for declared event schemas; excluded tool-result rewrites stay excluded. Full
forks preserve the existing seed and event identities, including nested lineage.
The pinned turn-boundary projection keeps its last Turn number; omitted closed
Step references are cleared. Todo v2 and Plan v4 contain no sequence references.

Limits apply before JSON parsing, append, seed hydration and installation. The
process transport accepts UTF-8 JSON lines with at most 1 MiB before the newline
and 64 calls in each direction. It decodes complete lines directly and owns any
partial bytes across stream writes. A Session
mirror is limited to 100,000 events and 64 MiB encoded bytes, with a 256 MiB
aggregate mirrored-state ceiling. These are admission bounds, not OS RSS quotas.
# Human review mapping

For native preset Tools the captured Agent's original Cordis execution hooks
surround a single native continuation. The Tool name, arguments and shell
approval remain those admitted by RSI. The original approval service can route
an invocation's policy ask to the same native process review before the start
is published. Its answer resumes the pending DSH waterfall. Once that review
is answered or the native body is entered, subsequent plugin questions go to
the original Cordis answerers. The application journal
retains the service's paired `approval/asked` and `approval/decided` records and
its session-level `approval/policy` override. Titles and these log-only events
need only their Session sequence. The journal allocates a mutation identity
for operations that can acquire a native receipt or correlation.
Installed Cordis hooks execute with the application process's authority while
deciding whether to call the native body. The native Tool owner reads its
authorization from the native review. The application can deny a call before
the continuation or change its model-facing content afterwards. The native Tool
owner retains the resulting output with its actual enforcement. A connection
loss never causes the bridge to dispatch the body again.
The pipeline's asynchronous invocation scope also owns the temporary native
definition. On settlement it releases both the call and the definition, including
when a plugin keeps a descendant timer or callback alive.

`agent.before-step` stages the original prompt assembly and pre-step waterfall.
Its system instructions are distinct from ordinary input messages and commit
with the journal and Tool subset. The bridge uses original `renderPrompt` for
interpolation. Names owned by other RSI plugins remain in the offered catalog;
the original DSH resolver narrows the DSH-owned names.

The bridge sends `user-question.ask` with the exact Session and Tool operation
identity. Original Plan review metadata becomes a closed RSI review with explicit
approve, keep-planning and dismiss actions. The Rust owner assigns the content
binding and Turn identity and parks the Kernel's human-wait lane. Only an explicit
dismiss action constructs the original singleton `UserQuestionError` with
`ASK_CANCELLED`; abort and transport failures never imply dismissal. Approval
maps back to the original label, and feedback is preserved as custom text.

# Command publication

The application mounts the release's root Include. Its base document holds
the selected application entries. Bundle and profile patches are applied
above it by the same DSH Include used by ConfigEditor and Settings. Updating
an index or plugin setting therefore edits the actual running entry and its
private profile patch.

The application's PluginPackages service uses DSH's metadata reader for
localized titles, descriptions and icons. When the caller's ESM resolution
selects a leased package's own exported root manifest, readers can share its
successful, read-only metadata for the lifetime of that package binding.
After that first resolved read, an exact root request with the same active
binding uses the cached metadata without resolving its resource again.
A bare resource lookup from the application profile follows the nearest
installed package link to its current leased directory. Manifest and version
lookups use the same binding as module resolution, including for packages
whose exports omit `package.json`. Switching or restoring a market selection
changes subsequent lookups from the same profile URL. Removing the profile
link ends that public route even while a Fiber holds its old lease. Code
still running in a leased package resolves its own captured dependencies.
A successor binding reads its own bytes. Editable paths, subpath metadata
and diagnostics continue through the original reader on each lookup.

Rust publishes the final preparation and staged extension journal atomically.
The bridge reconstructs entered messages from that Fact at its committed time,
including IDs and sources, so a plugin can recognize its input after restart.

The release application and registry importer are separately installed
selections. Starting the workbench verifies its runtime closure. Registry
inspection acquires the exact internal npm payload on demand. The importer
and Discover share an npm cache in the Host-owned state for this profile.
Opening the application moves its earlier npm cache out of the portable
profile, preserving downloaded data. Each build still resolves into an empty
staging tree. The importer
declares that toolchain as a strong dependency and resolves the application
layout and runtime shards from its own lease.

The release packer keeps DSH's managed subprocess runner and Windows ACL
runner with their transitive installed dependencies in one runtime payload.
Their child Node processes resolve packages directly from the npm tree on
disk. The application process's resolver only serves its own process.
Registry metadata and npm staging use the Host's HTTP(S) proxy and bypass
settings. The generated application profile and npm subprocess omit proxy
URLs with user information and keep their private package configuration.

Release imports use the npm executable from an exact toolchain lease. The
importer resolves the requested package in a private staging directory with
the selected runtime's packages and npm's normal strict peer checks. It
emits private package shards and a selection describing their Node lookup
graph. Each edge into the host records the resolved npm location and version.
The selection leases its private shards. The active application supplies host
packages at the captured lookup location or the hoisted top-level location at
the same version. It owns their internal graph, so imported selections do not
pin copies of runtime shards. When the DSH release changes, activation checks
the plugin manifest's DSH requirements against that release as well as its
captured host dependencies. A fresh import resolves changed dependency
versions. The profile obtains private payload paths from Rust's retained
selection before publishing installed package links or enabling a bundle.

Original Tool execution observes its captured ToolStarted prefix before the plugin body. The recorded model call id is passed to the DSH execution pipeline; its invocation precedes any todo/write event in the same atomic settlement. A monotonic DSH guard binds exactly one root execution to the admitted agent, tool, arguments and call id. The Agent adapter stages a finalized tool error with its hook events and contexts. A tool outside the admitted Step or a displaced human question remains a rejected transaction.

A resolved tool view belongs to its initiating Agent. A visible definition
remains eligible only while its exact registration is still visible in that
scope. Disposing a view withdraws its calls. Removing and registering the
same definition object creates a new occurrence. An outstanding call checks
this at the original registry's final lookup, including after async hooks.

The Agent catalog uses protocol 5 and carries ordinary command descriptors. A
command runs the original handler after synchronizing only its captured durable
Fact horizon. Returned `inject` and `steer` text travels with the staged journal;
the RSI owner assigns its identity and commits the entire batch atomically.
Draft confirmation uses `draft_committed` at journal revision zero. It is distinct
from durable publication and remains local until the first Session submission.
Lost replies and acknowledgements are reconciled against the retained owner
outcome, never by replaying a handler. A command committed during a parked review
changes the Session epoch, so the old answer is rejected as `ASK_ABORTED`.


The mirror count limit is 256 concurrently retained Sessions, not 256 over the
process lifetime. Capacity pressure evicts only settled idle mirrors. Newly
loaded mirrors, active/queued callbacks, parked questions, tentative operations
and incomplete load transfers remain pinned. Receipts for evicted mirrors report
`{"state":"unloaded"}`; the RSI owner reconciles canonical evidence before accepting
that response and reloads the journal before another callback. Failed load
transfers are explicitly aborted; no persisted plugin state is owned by the cache.
Before installing, Discover inspects a candidate through the same registry
and npm toolchain as its install. Metadata goes to stdout, diagnostics to
stderr. An inspection does not publish a package or enable code.
The release and installed plugins share a generated `node_modules` view in the
DSH profile. Opening the application or preparing a plugin points its managed
directory link at the currently leased package, including when the previous
link is stale or dangling. A regular file or directory at that location is a
collision and is preserved.

Bundle activation follows the order in the portable profile. A bundle shipped
as a dependency of the selected DSH runtime resolves through that runtime's
leased dependency graph. Enabling it uses the existing installation, even if
the profile also declares its name. Other bundles resolve through their
committed market selections. Both sources use DSH's platform and version
checks, including the profile's exact version exemptions, before loading
patches from the owning package. An unreadable or incompatible bundle skipped
at startup is evaluated again on reconciliation, so correcting the profile
can activate it without restarting the Host.

The application keeps its Store selections in per-profile Host state outside
the portable DSH profile. Package view changes record the previous selections
before modifying links or the manifest. Cancellation, failure and interruption
restore the prior package view. Only a successfully prepared view advances
this journal. DSH retains ownership of bundle enablement and its activation
result. Restoring a backup re-resolves the portable manifest against the
target Home's Store.
Before changing the portable view, the market retains both the committed
and candidate Store roots for this Host profile. Once the journal commits,
it narrows the roots to the chosen selections. Opening the profile repairs
extra reservations left by an interrupted handoff.
Market admission cannot replace the CLI's package selections or another
workbench profile's roots. A failed candidate can be reclaimed once its
temporary reservation and live leases have retired.
After successful Cordis reconciliation, the market releases payload leases
for imported graphs no longer selected by any installed package. A graph
still in use by a Fiber remains leased until its retirement completes. The
application's fixed npm lease can serve subsequent inspections.
Restoring a committed profile keeps healthy bundles running when another
installed bundle is unavailable. The Host reports the affected package or
Fiber. The workbench's required Host entries must start. Subsequent changes
use DSH's reconciliation contract, which distinguishes an unchanged inactive
entry from a new or changed activation failure.
Discover's package subprocess performs a raw package operation. The external
market's recoverable install seat performs a DSH plugin add, including bundle
selection and activation through the original Plugin Manager. These two entry
points have different enable semantics.
An external market add for an already installed registry package can replace
its package view. The calling market owns its update verdict, rollback and
restart UX. Staging a replacement leaves the running Fiber serving its
request. Reconciliation retains retired graphs while a loader entry still
uses a module imported from their payload. Restart resolves the committed
selection through a fresh Cordis tree.
The root Include reads the managed profile's cordis.yml. Original plugins and
the configuration editor can change this file and the profile's patch layers.
The managed registry importer can install a newly published npm version
immediately. Its profile advertises that default with
`minimum-release-age=0` in the local `.npmrc`. Operator release-age
settings in that file, the workspace policy, or the application environment
keep the precedence defined by the market. Linked and read-only configuration
files belong to the operator.
Bundle layers use the selected DSH app-boot's patch reader and preserve the
order of all package-relative patch files declared by a bundle.
Sidebar Session lookup refreshes the authenticated request's native Session and
working directory; owned live Agent identities also resolve outside requests.
The bridge authorizes the actual Session, child and root
identities supplied to sidebar RPCs before the published handler runs.
When a client also sends a working-directory hint, the released sidebar
resolves the working directory from that authorized Session. A stale hint
does not redirect file reads or prevent the editor from opening the Session.
The plugin's global methods also accept an empty JSON body.
Authenticated sidebar WebSockets may establish a global connection without a
Session URL parameter. The plugin owns its watch-frame protocol; the original
Side Chat socket carries only stale-thread notifications and reads transcript
bodies through the ordinary native-authorized HTTP route.
The workbench's subagent catalog reads native Session-backed child identities
in stable pre-order. It exposes direct children and descendants without starting
an Agent. Unknown live state and program-owned branches are reported as DSH
diagnostics. Operator catalog reads never acquire a model's execution authority.
The released workbench reads topology through Session projections separately
from live activity. A parent's projected child catalog joins successful native
spawn receipts through that Session's conversation cut to visible immutable
child headers. A child still awaiting its parent Tool result is discoverable
in the live tree before it enters that projection.
Its `modelSelection` baseline reads the native model-selection projection and
its captured Fact cut. `Session.requestHeader()` returns the frozen DSH
canonical header from the latest committed `request/header`, including a
retained fork prefix. Before that event it returns `undefined`. `lastUsed`
comes from the latest canonical request header and omits an adapter-defaulted
effort. `next` retains the native choice even when a previous request used a
temporary override or its route is unavailable. A fork starts from its own
Header and local domain baseline. Published Sessions merge committed selection
controls into the observed log at their native Fact anchors. Those real
`model/selection` events advance the DSH cursor even without a model request.
The original Host-wide `session/control` stream forwards changed projection
values from active history readers, attached Agents and model commands after
checking the receiving request's Session access. A new control reader receives
all visible active baselines.
An immediately available history snapshot and its control baseline share one
projection read at the same Session cursor. A recovering assistant stream
captures its baseline after catch-up. Both
`session/control` and `session/observeProjections` send one frame per committed
event that changes a projection. Its `seq` identifies the event and `changes`
contains the ordered `{key, val}` replacements. Readers can recover from a
fresh baseline. Slow readers see intervening changes at their original cursors.
Per-Session subscriptions use the same publisher without opening a history
reader; their [passive subscription contract](session-journal.md) separates
readiness from fetching the baseline.
Refreshing an Agent's model options reads its Session owner's selection
directly. A transcript or an explicit projection request reads the full view.
Unpublished drafts still have no durable control history.
The application supplies shared Session journals and read-only Session persistence.
`stat` and `list` observe the same immutable headers and opaque revisions from
native metadata and the application journal. Listing reads authorized durable
Sessions in pages without opening their event logs. Registered live Sessions
can be merged with a catalog larger than one browser response. The native
transport bounds each page independently.
The original synchronous `sessions.list()` contract enumerates attached Sessions.
The workbench mounts the distribution's attachments and Session Query services
with attachments in the application profile and the release's index policy.
The optional [Session search bundle](session-search.md) has its own isolated
query service; its compatibility and performance acceptance covers the original
tool implementations over this persistence boundary.
The original file-upload service resolves a cold Session through the same
native-authorized Agent lookup as Typert. Uploaded bytes stream directly into
its attachment store, outside the extension JSON frame. The receiving Session
owns the original staged receipt; replacing the controller releases its Agent
resolver before registering the replacement.
The original export command can download root and descendant Session logs.
An unknown stored identity yields no stat result and a typed not-found error
on open. The original download route returns HTTP 404 for that identity.
`open(id, 'read')` uses the history projector. Each read authenticates through
the opening request and observes a
current native cut; it never starts an Agent. Native projection batches publish
atomically, and concurrent readers share one source cursor and application log.
Stored handles exclude unpublished
drafts, preserve inherited event counts and return frozen event values in fresh
outer arrays. Read handles cannot append or flush. Closing is idempotent and
invalidates later reads. The bounded captured-view cache includes the native
draft revision or durable Fact/control pair and the application journal revision.
Persisted opens and reads use the metadata-only native read, including a cold
open. Its immutable model baseline and indexed Fact/control cut are sufficient
to project history and model changes. A changed revision passes that exact cut
to the projector without a second opening request or a live model projection.
Draft capture still uses its live snapshot; persistence never opens a draft.
A pending capture orders later captures for the same Session. Readers of other
Sessions proceed independently. Point and last-event lookups stay within the
captured prefix and allocate no event array.
A locally accepted model choice invalidates it before the native command reply.
Captured views retain their original event interval. Request-local `sessions.get()` exposes only explicitly
authorized targets; file operations still use their native working directory.
The original `session/selectModel` invokes the native Session command and returns
only after its receipt. It preserves an omitted effort and changes this Session's
next requests. It does not write DSH's separate global default file.
Each attached Agent exposes DSH's `AgentModel`. `model.current()` reads the
recorded selection or request, then the Agent's initial options as a fallback.
`model.select(choice)` skips a matching recorded choice and otherwise appends
through the same native publication boundary as a direct Session write.
Attached Agents accept `Session.append('model/selection', ...)` synchronously into
the same application journal and return the stored immutable event. The current
HTTP or owner-activity publication reserves the write before acceptance and waits
for its native receipt. A failed choice prevents dependent Agent submissions;
a later explicit choice supersedes its retry. Original workbench choices use this
same driver. Other native execution-event writes still require their owning
native command. The [journal contract](session-journal.md) owns persistence,
correlation and recovery semantics.
On the Agent side, working-directory reads use the current native Session
mirror's canonical local cwd. Changing a native Session's execution coordinates
requires a new Session. A remote or missing local directory cannot fall back
to the adapter process's own directory.
Invalid JSON or an oversized sidebar JSON request has the plugin's HTTP 400
bad-request envelope. A rejected Session or workspace has HTTP 403.
After admission, handler failures propagate to the original WebServer for
logging and response handling; they are not reclassified as authorization
failures. Staged native writes retain their publication failure response.
Document aliases strip the mount prefix before request admission, including
fallback handlers, so both URLs use the same Session and body rules.
The original `session/create` opens a native draft. A Workspace ID and an
explicit local cwd are mutually exclusive. Without either it uses the first
registered local Workspace visible to the browser owner. A matching blank
draft can be reused. The first message publishes it into the durable list.
The original `session/fork` uses the native Turn identity on a projected
`turn/end` event. Accepted create and fork commands publish the native receipt's
draft summary through DSH's `api-session/added` event to the shared owner Peer.
The event updates connected browser catalogs without a reload or an Agent start.
Native creation receipts and draft listings both mark a completed-history fork
nonblank, including a reconnect before first input. An ordinary untouched
draft remains blank and its original UI may hide it outside the active view.
List queries remain authoritative after reconnect. An omitted fork cursor
selects the last completed local Turn.
The new root can continue independently. A cursor inside an open Turn
requires a separate interrupted-history seed and is refused explicitly.
The original Workspace feed groups Sessions by native execution coordinates.
It publishes a baseline and sends a replacement when the visible Workspace
registrations or Navigation membership change. The current native registry
has no change stream, so a connected follower samples it once per second.
The feed includes the browser owner's native ready drafts until publication
or expiry. The draft list and the durable navigation seed share Session IDs.
Workspace creation, rename and deletion use the native registry. An existing
directory registered twice returns one creation and one reuse.
The original `session/prompt` accepts text for an existing native Session.
The DSH request ID is the native durable message ID. Queue and steer preserve
their respective delivery modes. File receipts and inline images require a
native Media import and currently return an explicit error.
The corresponding committed human message carries that same ID as its DSH
`source.rpcId`, allowing the composer to settle its local pending bubble.
The workbench's ordinary Session cancel command sends native Session-wide
cancellation with `keep_inbox: true`. It cancels the accepted open Turns and
pauses the inbox atomically, retaining pending input until a new waking input
arrives. A cancellation receipt acknowledges the durable request; it does not
assert that executor cleanup has finished. An uncertain call is not replayed
against a later Session cut.
Synchronous application mutations use a request-owned serial publication queue.
The first staged mutation holds the finite HTTP response until every staged
operation has a native receipt. A later operation does not start after an earlier
failure. Failure replaces a buffered success with an error; earlier committed
operations are not rolled back. Disconnect cancels pending work, and neither a
failed nor uncertain write is replayed under a new identity. A mutation cannot
be staged after response bytes have been sent. A handler that only reads streams
its response directly. The first staged write installs disconnect cancellation
and starts the ordered queue. Buffered replies are limited to 1 MiB and 4,096
response write operations.
The adapter's asynchronous command access forwards the exact native list,
invocation and receipt contract through `application.command`. Queuing an
operation is not a durable receipt and does not produce a synthetic SessionEvent.
The released terminal controller's Remote contract uses its ordinary Agent
lookup. The bridge checks the live browser request and addressed root Session before
lending its identity. The terminal client sees the native shell and its
actual workspace. Creation and closure use the client's terminal ID. Closing
an unseen or pending ID prevents a delayed create from reopening the tab.
The gateway returns the published `terminal/unavailable` code for a retired
key or missing binding, so the original client removes the missing terminal.
Attachment takes the native writer explicitly, and unmount releases the follower while the
shell remains available. A Remote attachment emits one initial snapshot.
Terminal output and input each keep one outstanding read. A busy PTY does
not accumulate waiters on an idle uplink. An output page emits a state frame
when the displayed dimensions, process state, exit code or this attachment's
write access change. An accepted resize also returns its state to the writer.
Subsequent native screen replacements repaint the same xterm through
sequenced ANSI output. Local shell selection and sandbox policy belong
to the native Session. Display titles belong to the application generation.
On an independent, unseeded Session, the workbench projects committed Facts
through the same DSH event and model-attempt adapters as the Agent. Its
opening snapshot and subsequent durable events use DSH event cursors.
An opted-in follower joins the native live model prefix to its captured
conversation attempt. A reconnect receives an accumulated baseline and
subsequent dense DSH chunk frames. Model observation has its own cursor.
Each native wait is observed once, regardless of how many frames arrive from
the other source. Retiring an attempt drops its outstanding completion and
closing the follower releases its durable wait and model reader.
Only committed Session events advance the durable conversation cursor.
An empty native draft may have a baseline cursor of `-1`. Host-wide projection
deltas require an actual event sequence of zero or greater; opening a blank
mirror cannot publish its baseline cursor as an event.
Selecting a seeded history reconstructs the retained ancestor intervals
before the child's own events. Full and empty inherited prefixes use the
same fork projection as the Agent bridge. A selective suffix that needs an
unavailable projection checkpoint reports its limitation. A subagent address
must identify the child's actual direct parent.
For a manual Side Chat fork, a native Turn boundary in the supplied DSH seed
determines the cut directly. When the seed lacks a boundary, the factory reads
the attached parent's events only through its first local Turn start.
The release application runs the original Cordis workbench and its module
resolver in one Node Worker. The process owns the bounded extension carrier
and its heartbeat while the Worker reads and evaluates plugins. Close waits
for the Cordis scope to retire; losing either side terminates the carrier.
The generated brand belongs to the writable application profile. Its assets
can be republished on restart or upgrade even when an older asset inherited
the Store's read-only permissions.
When the Host requests opening timings, the Worker reports setup, Cordis
composition and profile reconciliation durations with its normal ready reply.
For Plugin Manager installs with a request ID, the Host records the intent
before starting the original installer and its return value before replying.
Concurrent equal requests join one installation. Repeating the ID with the
same arguments replays the saved result after restart. A reused ID with
different arguments is rejected. A process interrupted before saving a result
reports an unknown outcome for that ID; the user can inspect the installed
bundle and submit a new operation. The private profile retains up to 128
recent requests within an 8 MiB receipt budget.

### Native inbox capture

The application inbox reader captures the native durable inspection once, then
reads its exact acceptance records. It preserves native message IDs, routing,
source classification and queue slots across process restarts. Fragment assembly
checks byte offsets and UTF-8 boundaries before exposing a complete value.
Opening supplies complete bounded metadata without nested JSON encoding. An
empty snapshot needs one call and retains no native resource; other snapshots
are closed after their message reads.
The native reader reuses one encoded acceptance across consecutive fragments
and releases it at the final fragment or when another message is read.
One capture retains at most 64 pending messages and 64 MiB of encoded message bodies;
each message stays within the native 36 MiB record limit.
An unpublished inbox exposes its native held command inputs and draft revision,
without durable control cursors or queue slots. An unavailable inbox is an error.
An attached draft Agent waits for native revision notification before refreshing;
it does not poll the inbox or history. Publication switches the same observer to
the durable history feed. Detaching the Agent cancels its pending wait.
One opening transaction owns each Session's attachment through setup and
publication. Concurrent workbench lookups join it; a second factory attachment
cannot replace its native owner or publish another Agent.
For an unpublished draft, before publishing or running setup, the Agent acquires a native owner under
the application callback, independent of the browser request. A captured durable
Session needs no ownership request. Its Cordis lifetime
releases that owner on disposal or failed setup. Acquisition cancellation also
releases a possibly accepted owner using the same key. Explicit native discard
and Host shutdown remain effective while an Agent owns the draft.
Pending reads are snapshots, not locks on the scheduler. A withdrawal retains
one native operation ID and exact predecessor, and exposes the committed receipt
including claim/replacement rejection. It never uses message cancellation, which
can cancel the executing Turn after the message has been claimed.

The workbench's `session/updateQueue` resolves the displayed message against
the Session's pending inputs. Editing replaces the content of a queued human
message with the supplied text blocks.
Browser prompts carry their DSH message ID and user RPC source into native
acceptance, so an edited message retains its identity when later consumed.
Removing withdraws the input. Steering converts a queued human message to a
next-Step input bound to the currently active native Turn. The Kernel checks
the queue slot and exact predecessor together and records its decision. The
workbench acknowledges a durable change only after reading that decision.
Unpublished command inputs can be withdrawn through the draft owner. A
consumed item or an unavailable steering turn returns the corresponding DSH
queue error. Upload retention ends when removal succeeds.

Attached Agents use the [application Session journal](session-journal.md) for
synchronous text input, pending reads and removal. Original DSH folds, workbench readers and Agent
notifications consume the same accepted splice events. Native command receipts
and queue receipts settle those intents asynchronously.

`inbox.clear()` synchronously records at most one clearing splice per horizon,
then clears the native pending batch without cancelling execution or altering
suspension. `Agent.cancel()` defaults to clearing input; `keepInbox: true`
retains it. Cancellation uses one native Session stop. Each staged input flush
captures its application event boundary so a later wake cannot overtake a stop.
Clears never replay a native capture after an uncertain result. Unconfirmed
optimistic clears reconcile against an authoritative inbox snapshot, restoring
still-pending native messages with their original acceptance identity; restoring
a projection does not resubmit input. The shared journal owns that reconciliation.

`inject()`, `followup()` and `steer()` submissions use native direct application/user
ingress with `NextStep`, `NextTurn` and `Steer` intent. Each call captures the original
message ID, source and text/file blocks before asynchronous publication and allocates
an independent native request ID. Native accepted inputs and consumed Facts
retain that attribution, so pending projections and cold history show the same
original envelope. The shared journal accepts the inbox insertion synchronously
and drives the prepared submission after flushing it. Recovery, pending-ID
uniqueness and withdrawal use the same acceptance owner as non-waking injection.

Prompt image admission uses the selected AttachmentStore to resolve encoded inputs and enforce its message limits after upload binding. Native submissions and plugin inbox messages retain the published digest, intrinsic shape, display name and optional original dimensions. The same identity is used by request hooks and replay.

A live assistant settlement and its end frame are delivered together, before subsequent Step or Turn events from the same native observation. The original client holds the settlement until it receives that end frame.

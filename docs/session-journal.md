# Application Session journal

The compact metadata prefix includes the committed event count. Along with
the native Fact and control watermarks it identifies a Session log revision
without opening the event body. Older prefixes acquire a count on their next
publication.

New journals keep the UTF-8 catalog line followed by one checksummed Zstandard
frame containing the remaining JSON bytes. A cold title or count reads through
the first newline. A full read consumes the complete encoded body and restores
the original bounded UTF-8 document. Unconsumed trailing bytes fail recovery.
The writer replaces both parts atomically. These files live under
`sessions/packed/`. Existing flat JSON journals keep their original paths and
encoding, including on subsequent writes. Each Session has one writable file.
The catalog discovers the profile's journal filenames once and reads a prefix
only for a listed native identity with a matching file. The profile writer
publishes new filenames to that catalog after successful atomic replacement.
Native-only sessions require no per-session storage entries or file opens.

`SessionProjectionJournal` owns the application event log shared by attached
Agents, workbench history and cold persistence. Native Kernel owns execution.
The attached Agent's model-selection append and the ordinary workbench model
selector both use this log and its native command driver.

A cold Session query can prepare a detached DSH Session from the persisted
header and events. Preparation preserves the seed's ownership mode and
inherited boundary, checks for an attached Session with the same ID, and
leaves the live registry and native store untouched.

A native draft can change Agent preset without changing Session identity.
Its stored Header with zero Facts and controls establishes the identity. Draft
revisions follow that Header and precede the first durable Fact or control.
The application retains its original creation Header and records a changed
native choice as `agent-preset/selected`, before the events in the same newly
observed cut. Re-reading a cut adds nothing; an older draft revision cannot
undo a newer choice. Selection records and native events publish atomically.
The compact journal keeps those records and the original Header so a cold
reader reconstructs the same immutable events. Native Session admission owns
the executable Host composition. An original DSH-only declaration can supply
a Cordis scope on that composition. While such a selection is recorded, the
journal remembers its underlying native preset so a cold reader can distinguish
an unchanged Host from a native switch made while the workbench was closed.
The native owner advances the cut when changing the preset. For a published
Session before its first Turn, executable generation controls carry the
effective preset at their Store timestamp. Replaying them updates the Cordis
scope even when the creation Header still names the original preset. Draft
selection times record local observation time.
Preset identifiers in the Header and selection records are nonblank strings of
at most 256 UTF-16 code units; native admission owns the preset-name grammar.
The workbench exposes the release's `agentPreset` Session projection to
clients and plugins. It starts with the creation choice (or null) and
folds committed selections in log order. A resumed Agent uses that same
projection to discover its preset's packaged skills.

Plugins read the model-visible messages with `session.deriveMessages()`.
Observed DSH compaction starts, summaries and ends are log events. The
checkpoint user message carries the surface replacement. When native and
application sequence numbers differ, the summary's range endpoints and every
shadowed sequence refer to the same messages as that replacement. A selective
fork must contain those inputs to retain the summary.
The native installation Fact authorizes the replacement. A provider settlement
alone supplies its text but cannot remove history. Native selections can leave
protected instructions between two selected intervals. The projection keeps
those messages with their original identity and content. When the release's
contiguous replacement needs a copy of a protected message, the copy points
back to its source and stays out of the human transcript.
The original preset-scoped `/compact` command delegates idle compaction to
the Host with its command ID. Its completion links to the projected installed
summary. A busy Session or an empty selection returns the original command
outcome. An already-running model Turn keeps its execution owner.
During an open Turn, an enabled plugin can pass two retained surface sequence
numbers to `compactRegion`. The bridge resolves these to the native positions
at the observed Fact prefix. The system head and partial tool interactions
cannot be selected. The result names the installed checkpoint, its summary
event and the application sequences it replaced. A plugin extending the
released basic engine can supply its own summary without configuring a
conversation model. For a plugin-supplied summary, the bridge captures the native
positions after caller authorization, at the same surface the engine starts
summarizing. A later change to that surface invalidates the replacement.
The Host records the Loader entry that supplied the engine,
including when another plugin calls it. Unloading that engine closes its ability
to submit new checkpoints. The Host stores the framed user message with each
text block in its native `content.text` field. Plugins and replayed DSH events
receive the same strings in DSH's `text` field, in their original order.
The released engine owns token pricing, error recovery
and checkpoint framing for this operation. Its opening event is visible while
the summarizer runs. The journal correlates that opening with the Host's
installed checkpoint. A summarizer failure closes the same opening with the
original DSH error. Only a confirmed installation supplies a replacement message.
Replay resolves its inclusive native coordinates in surface order, skipping
system messages and synthetic tool results. Nodes after the selected span
remain available without replay reading their message bodies.
It returns a fresh list in the release surface's order, with its replacements
and empty-message rules applied. `deriveEventMessage(event)` uses the same
surface interpreter. A full `snapshotEvents()` read shares a frozen snapshot
until the log advances. Previously returned arrays retain their original cut.
On a live Session, `eventAt(seq)` returns `undefined` for an absent position.
The half-open `snapshotEvents(start, end)` range stops at the current tail
and returns an empty frozen array when it contains no events.

An attached Agent exposes the release's `session.firstLifecycleSeq`. A newly
created fork starts at its inherited cut, including its own seed marker.
Reopening that fork starts after its stored events. This offset belongs to
the current Agent attachment and requires no storage write.

`session.observeEvent` registers a passive listener before returning `ready`.
It can subscribe before a Session exists. It reads no baseline and starts no
Agent or native history wait. Events from the registered Session's Cordis
scope retain their original sequence. On creation, the listener includes
events appended after that Session's `firstLiveSeq`, excluding restored
history. Cancellation or owner disposal removes the listener.

`session.state` reads the current event cursor, driver status, queue and pending
remote input without activating an Agent. A detached Session has a null queue.
`session.observeState` opens with that same state and sends complete replacements
when the addressed Session or Agent changes. The reader's existing Session grant
applies to both operations. Neither operation writes a saved state snapshot.

`session.observeProjections` also returns `ready` after registration, including
for a Session that does not exist yet. It consumes the same committed changes
as `session.control`. An active transcript, an attached Agent's native
observer, or a model-selection command supplies the projection source. A
model command publishes its accepted choice even without a retained Agent.
Adding subscribers performs no
history read, baseline calculation or native wait. Opening a source supplies
the Host-wide baseline; passive per-Session listeners receive subsequent
event changes. Model choices, inbox entries and native child catalogs retain
their existing event coordinates.

DSH hook handlers append their log-only `hook/invoked` and `hook/result`
records to the same Session. Their turn, point and handler ID survive cold
replay. Neither record changes the model-visible conversation.

The released title provider appends `session/title-llm-request` with its input
message positions, route, system prompt, messages and output budget before
opening its model stream. The same journal retains this log-only evidence
across reload. It allocates no native turn or mutation receipt.

The original message-feedback service owns rating validation, version comparison
and no-op detection. Its `feedback/message-put` and `feedback/message-delete`
events are log-only application events in this same journal. Live writes use
the attached Session; cold writes use the persistence write handle. Both flush
before reporting success and survive cold replay without another feedback store
or a copy of the native transcript.

The original action-card service owns the recommendation switch, proposal
projection and user decisions. Its `action-cards/decision` records share the
Session journal. A cold reader recovers the same decisions from the assistant
messages and those records. The decision itself adds no model-visible message.
Profiles with package management load the released page and plugin
recommendation providers. Their skills and actions follow the DSH profile
settings and registered services.

The original `/feedback <text>` command and `sessionFeedback.record` Remote
append `feedback/record` to this same journal. The event is log-only and does not
enter model context or trigger a Turn. The Remote accepts a live Session and
acknowledges synchronous acceptance. Live log-only appends, including SDK
plugin records, schedule one journal write within 200 ms. Appends during a
write share the next batch. Reading an unchanged native cut sees live events
while their batch is pending. Explicit Session flush, Agent disposal and normal
Host shutdown drain accepted records. A forced exit can lose the latest
acknowledged batch. A failed write retains the live events for the next flush.
A missing live Session returns the original `session-not-found` result.
Command bookkeeping follows the release's `recordInput: false` policy, so the
remark is stored only in its feedback event.

The DSH job registry appends `job/registered` and `job/settled` to the
owning Agent's Session. These log-only records preserve the original job ID,
tool-call identity, timing and outcome across cold reads. The live registry
owns the process and its output cursor. `dsh-tool-jobs` delivers an uncollected
completion to the Agent through its inbox.

The journal owns one dense immutable event sequence. Local acceptance is
synchronous and returns the exact stored event; persistence is asynchronous.
When a plugin creates a seeded child, the native fork identifies the stable
parent Turn. Reference-free `workspace-root/change`, historical
`working-directory/change` and `subagent/descriptor` events supplied at the end of the inherited prefix
belong to the constructor. The journal keeps their order, times and payloads
immediately before the child's tagged `session/end-seed`. They count as
inherited events for DSH projections and have no native Fact position.
Cold replay uses the same boundary. A child created before these events
were recorded has only the metadata present in its log.

The original subagent manager appends a descriptor to a newly established child
and a catalog entry to its parent. These are log events and survive cold replay.
Only the manager establishing the child can record its delegated sandbox mode
and permission preset through the Agent mirror.
Preceding observation records must be log-only events. They cannot precede the
initial inherited prefix or its constructor annotations; such a batch is rejected
before publication so every accepted layout can be restored.
Already prepared invocation metadata is installed before synchronous observers
see its event. Readiness walks the journal's event-position index only through
the boundary captured by the calling mutation, retaining progress across calls.
Native model controls correlate only with requests accepted before the
observation started. An intervening local acceptance cannot claim a control
from a page already in flight.
Observer errors cannot undo acceptance or prevent later events, and reentrant
mutations are rejected before modifying the log. Native observation batches are
validated as a whole before publication.
Source-map additions and changed mutation records are staged as a delta; a live
delta does not copy the retained source map, enumerate settled mutations or take
a full event snapshot. Existing immutable events are read by position. Validation
failure leaves all three logs unchanged. The journal validates new events against
the existing release surface. Its batch preparation includes earlier events in
the same batch, then commits the complete suffix before observers run. Ordinary
append-only deltas retain the log and its incremental surface state.
The private native projection stages its new events against an immutable
prefix. It prepares the suffix using the original surface before publishing
either history. Reading the staged surface itself can require folding that
private view. When projecting a new input or model request in an append-only
batch, the system prompt at the head comes directly from the committed surface.
A staged replacement or a change to the parent requires the batch's own view.
The native projector transfers deeply frozen event values under an explicit
`shared-frozen` ownership contract. An event whose coordinates and references
remain unchanged retains its native object identity through live merge and cold
reconstruction. Remapping creates only the changed containers; unchanged message
bodies remain shared. Native inbox transition
records refer to that same admitted message. The journal snapshots externally
owned mutable inputs once; it does not infer safe ownership from a shallow
`Object.isFrozen` check. Inside the explicit shared-frozen transfer, the bridge's
final freeze visits only newly owned containers and stops at frozen subtrees.
Within that transfer, admission can reuse an immutable event's encoded byte
count and completed event-local validation by the same DSH validator. Weak keys
follow event lifetime and retain neither encoded JSON nor event bodies. A new
or remapped event crosses validation again. Every receiving log still checks
its envelope, contiguous position, surface relations and total size before
publication. A frozen external object is not evidence of prior admission.
The canonical request header freezes its new outer wrapper while sharing the
event's immutable configuration and tool schemas. Request-evidence JSON is
decoded into privately owned values; its newly constructed request-header event
transfers those values directly into admission without another schema copy.
Settled native model projections likewise transfer their privately assembled
event into admission. The original DSH stream accumulator supplies a detached,
immutable compact stream; its closed blocks and usage can be shared with the
assembled message. Admission freezes newly owned containers without copying
that stream again. Native input records remain independently owned. Completed,
interrupted and diagnostic-only attempts retain the same validation and history
semantics.
The native model translator retains only each open block's content and closes
that block directly, without assembling every preceding block. Live forwarding
uses the compact stream accumulator alone. Settlement passes its immutable
snapshot once to DSH's `assembleAssistantStream`; the original assembler owns
final block ordering, usage and interruption/truncation rules. Open content is
released at termination, and no synthetic close is added for an interrupted block.
Native Turn/Step markers, converted input and Tool messages, inbox splices and
model choices also transfer their newly constructed event graphs into admission.
Conversion detaches borrowed provenance, authored-message sources, image
dimensions and native Tool metadata before transfer; it does not freeze or
retain mutable children of the original Fact/control records. Already admitted
Tool-call arguments and inbox messages can remain shared immutable values.
The producer does not mutate a transferred graph. External callers of
`appendObserved` still receive snapshot isolation, and every transferred event
retains the same schema, surface, coordinate and capacity checks.
Each live native history projection remembers the last verified inline Fact
coordinate, SHA-256, byte count and projected value for each request section.
A staged cut inherits those bindings from its captured parent. Its replacements
become visible on commit. A matching reference reuses the projected settings,
tool definitions or system content; the request still checks its captured model
route. Other references to the same earlier Fact share one read within that
request. Inline bytes are verified on every admission. No original evidence
text or page is retained across cuts. A restored or independent projection
resolves references from its own history.
Request-header changes compare JSON structure, not its serialized spelling:
object key order is irrelevant, while tool order, array order and values remain
significant. Comparison can stop at shared immutable schema subtrees. A new
Step with the same header still records a `series` boundary; a changed header
records `change`. Prepared route settings use the same structural semantics.
This transfer retains event, surface and size validation and freezes the whole
owned graph. Externally supplied mutable inputs still cross the snapshot boundary.
Restored local records cross
the lossless-JSON boundary before being combined with the frozen native prefix.
Adoption still validates
event envelopes, surface relations and the retained-history budget before
publication. No second durable body or global interning cache is created.
A caller can catch a synchronous validation failure without failing other
accepted mutations in that publication. No native intent is created for the
rejected call, and it triggers no native refresh; already accepted operations
still settle normally.

Successful event admission computes its byte count and content digest from the
same temporary JSON encoding. The private admission record retains the count,
digest and validator identity, not the encoded string or another event body.
Journal reconciliation reuses that digest only for the admitted immutable
object; other values are encoded and hashed independently. Cold recovery verifies
the reconstructed native prefix against the journal's saved source digest.

Each consumed native event retains its source position, content digest and
application position in memory. Persistence stores only the position/correlation
map and one ordered source-prefix digest. The digest is SHA-256 over the UTF-8
domain `rsi.dsh.native-source-prefix.v1` followed by a NUL byte and the fixed-width
lowercase hexadecimal event digests in source order. It detects the same missing,
reordered or changed source content without storing one digest per event.
The rolling hash advances only after a whole observation batch passes validation;
flush copies its state without rescanning history. Cold loading reconstructs the
transient event digests and verifies the saved prefix before exposing the log.
Live partial observations retain their per-event checks. These digests are not
a runtime-version compatibility gate. Coordinate-only remapping of an admitted
immutable event shares its body and derives its exact encoded size from the
changed integer widths. The new envelope and reference containers are frozen;
size evidence does not establish event or surface validity. Receiving admission
still checks both. Such remaps compute their own digest only if it is requested;
they do not retain another serialized body. Unadmitted inputs take ordinary full
encoding and validation. Surface positions, source
event references, developer header references and command-result references are
translated into application coordinates. A native event explicitly correlated
with a local mutation must describe the same event body. Normally it aliases that
event and does not publish it again. A correlation marked `reconcile` instead
publishes the counterpart at the current application position. This preserves an
intervening external model choice and the later effective choice without moving
the original accepted event. One native source event can acknowledge one local
mutation only once; cold reconciliation preserves its original aliasing decision.

Inbox observations carry native message identities and command provenance in
addition to the original DSH message envelope. Their positional splices are
translated against the application prefix at publication, rather than applied
using native queue indices. A command acceptance aliases a local insertion only
when its prepared invocation digest, command, request ID, ordinal and complete
message match. Other native insertions follow the visible native predecessors;
unconfirmed local insertions retain their accepted identity. Local withdrawal
events remove a particular acceptance, so a later claim of that native input
cannot remove a newly accepted message reusing its presentation ID.

The inbox owner supplies projected event data to the journal. The source digest
always covers the unmodified native event; translation changes neither its type
nor its source references. Cold reconciliation derives the same projection from
the application prefix before the stored source position. A native transition
whose input is already locally withdrawn is represented by an empty splice;
native claim notifications still describe actual execution. Promotion cannot
resurrect that withdrawn acceptance. This observation contract is a prerequisite
for the Agent's synchronous inbox mutation driver. Native observations alone do
not prove withdrawal succeeded natively.

The inbox reader retains an application event cursor and folds only new events.
Unchanged reads reuse the immutable pending snapshot. Operation metadata is read
through the journal's event-position index: preparation and receipts become
visible without replaying the event prefix or changing an earlier public snapshot.
Native identity correlation remains a separate boundary check when a new native
transition is folded. An invalid splice leaves the last valid fold intact and is
rejected again on a later read; it cannot be skipped by advancing the cursor.
Native observations publish the source map and projection together before readers
run. No read cache survives a new owner or replaces cold boundary validation.

Attached Agents accept text `inject()`, `followup()` and `steer()` calls into this
journal before returning. Injection targets the next step without waking;
followup targets the next turn and steering targets the next step with waking.
The immutable original message is immediately visible through the Agent inbox,
Session events and workbench projections. Duplicate pending presentation IDs are
rejected synchronously. Native execution request IDs are independent generated IDs;
the caller's original ID and source remain presentation attribution. A finite
publication flushes the prepared invocation before native dispatch and records
its exact receipt. A later human submission waits for prior input intents.

All new input accepts prepare direct native submission with the complete original
attribution, ordered content and delivery intent. Recovery retries that exact
submission when the input is still wanted. A read-only native message-status
lookup and immutable acceptance read can settle a lost receipt without sending
again. Only the stable acceptance identity and cursor are retained as completion;
later claim or discard state is an observation, not a different receipt.
Injection uses non-waking `next_step` delivery. Its first acceptance publishes
the native Session and held input, without starting a Turn or resuming a paused
inbox. Empty drafts remain unpublished. The native Store therefore owns recovery
of accepted context even before the first question; no command catalog lookup,
command argument encoding or separate draft-input body is needed. Already
prepared command operations in older journals retain their original identity
until settled; they are never reissued as a different submission.
Idle native steering resolves to next-turn execution. Its acknowledgement aliases
the original next-step application acceptance; later removal locates that same
acceptance across the two presentation queues. Native promotion remains a real
transition. Neither case changes the immutable originally accepted event.

`remove()` appends a canceled splice for one acceptance. `clear()` appends at
most two canceled splices, next-step before next-turn, and settles them with one
native inbox-only clear. Agent cancellation uses the same synchronous projection
and one native Session stop; its default clears input, while `keepInbox` retains
it. An input removed before preparation is never sent. A prepared
invocation also remains known to be unsent in its live owner until dispatch is
actually attempted, including across a failed preparation flush. That live
knowledge permits local withdrawal; a prepared record loaded after restart does
not establish it. A prepared
input with an uncertain result is queried, not executed again merely to withdraw
it. An absent command or message receipt does not prove non-execution; the withdrawal stays
unconfirmed in that case. Confirmed durable inputs use the idempotent native queue
withdrawal bound to their original slot and message, never Turn cancellation.
An I/O failure preserves the accepted removal and diagnostic; a later readiness
check retries that same identity-bound single removal. A native claim remains a truthful rejection
of withdrawal, and does not retract the already published local removal.

A bulk clear captures native work once and is never replayed after an uncertain
result. While its live publication is pending, observers preserve its synchronous
projection. If no acknowledgement survives, an authoritative inbox snapshot
reconciles it before later dispatch: still-pending native inputs are restored by
new observation events referring to the original cleared acceptance. Those
events neither create a new execution identity nor resubmit a message. Inputs
known only locally stay withdrawn. Late native claim/discard events still refer
to the original acceptance and cannot remove a newer reused presentation ID.
The same reconciliation runs after cold journal loading.

An attached Agent also records native held draft inputs as observed acceptances.
Those records carry native identity and provenance, not a command to replay.
External removal while still a draft records a canceled observation. Publication
correlates surviving draft acceptances with their durable native controls. Draft
discard remains idempotent by message identity while that draft exists; a lost
draft after Host restart is not recreated by the application journal.
If publication races draft discard, the driver rechecks the native lifecycle and
withdraws the same identity durably. A missing durable slot after a confirmed
draft input proves that input was never published; it does not imply a claim.

Cold reconciliation verifies the complete native prefix. A live owner can instead
advance with a delta at the exact retained native cursor; it does not rescan or
rehash unchanged history. Batch validation shares the already validated immutable
prefix and publishes only after the whole new batch is accepted.

Each local mutation retains a unique request identity and its event position.
Preparation fixes the exact native invocation; completion records its receipt.
Input operations reference the already accepted inbox event for content,
attribution, delivery and message identity. A submission records its operation
kind, plus `delivery: 'next_step'` for non-waking input. Previously
prepared context-input commands retain their command, native revision and
invocation digest. Its request ID is the operation ID. The wire request is built
from that immutable event when needed; no second input body is retained in memory
or in the document. Cold loading verifies the command digest against this request.
These metadata transitions are immutable once assigned. A driver must
flush preparation before dispatching, and must recover with the same invocation.
The journal itself executes no command and owns no scheduler or retry policy.

`modelIntents` drives local `model/selection` operations through the native Session
command contract. It prepares one invocation from the advertised command and
revision, flushes that invocation before execution, and retains the actual receipt
before a publication can succeed. A lost reply is recovered by replaying the same
invocation; no new request ID or revision is substituted. A local selection made
later supersedes retries of older selections. Already dispatched work settles
before the later selection executes. The latest unresolved choice prevents the
driver's dependent submission from proceeding under an older choice.
The journal remembers the latest local model choice while publishing or
restoring operations. A lookup reads the current receipt by that identity
even when later inbox operations share the journal. This reference lives
only in memory.

An attempt failure is retained separately from a successful receipt. The current
native transport does not distinguish a rejected command from an unknown outcome,
so this driver reports an unconfirmed selection, not a definitive rejection. An
explicit retry can resolve the same operation. A later selection can supersede it.
Original accepted events are never erased. A stored failure is bounded diagnostic
text, not an instruction or an execution receipt.

Native model controls correlate only by the complete prepared invocation. A
matching value alone is insufficient. Draft publication folds several commands
into a baseline and carries no individual operation correlation; that baseline
remains its own observed event. A draft receipt proves process-local acceptance,
not persistence of the native draft after a Host restart.

Loading the model driver verifies retained invocations against their accepted
choices and receipts against the native command digest and successor revision.
An observed exact control can confirm an uncertain outcome without another
dispatch. Retained diagnostics do not negate a later successful receipt.

Runtime integration preserves model order across interleaving external
choices: aliasing an earlier local event is insufficient if a different native
choice was observed after it and the local command subsequently takes effect.
The owner publishes an explicit reconciliation event in that case. If a newer
locally accepted choice is pending, an older acknowledgement aliases its own
event and leaves that newer choice pending. The original Side Chat model fold
consumes these ordinary model-selection events.

The shared workbench owner stages native observation against a private branch.
Fact mappings, model state, inbox state and the native source cursor advance only
after the entire batch is projected successfully. Each caller supplies its own
authorized read function and cancellation signal; a retained projector does not
retain a browser request. Source positions remain separate from application
positions, including assistant-start and settlement cursors.
Live readers of the same model attempt share its settlement coordinate. The
coordinate becomes visible at commit and stays with each reader through its
terminal frame. Replaying settled history needs no per-attempt lookup table.
When both captured streams have unread data, the first Fact and control pages
load concurrently within the existing two-transfer budget. Projection still
interleaves controls at their Fact anchors. Both reads settle before the stage
continues or fails, so a failed stage leaves no unowned page transfer. Each
decoded page is consumed once; subsequent pages remain demand-driven.

Native workbench history transfers one retained encoded page through its UTF-8
fragments. Each Fact, control, exact-message or inherited Fact page uses a unique
reader identity and releases it on its final fragment. Aborted or failed reads
explicitly close the reader through the uncancelled release path; native request
retirement is the lifetime backstop. At most two page transfers run concurrently;
additional readers wait locally before issuing native RPCs. No queued reader
holds a native request slot. The Host checks the page's request, Session and
coordinates and bounds its retained storage; no persistent history copy is added.

Version 8 snapshots contain the Session header, owned and inherited event counts,
local-owned events at their original positions, the native source map, its
`sourceDigest` and mutation records in one JSON document. In native event order,
each source-map run stores the first application position and the number of
consecutive positions. Runs may occur in any order and cannot overlap. A
mutation's optional native source index identifies its correlation, including
when native events arrive in a different order from their application receipts.
Native-only event bodies are reconstructed from the
captured Store history, including translated inbox splices. They are not copied
into application storage. A correlated input acceptance keeps its original event
position, timestamp and splice coordinates, with `inserted: null` in storage.
The existing operation/source correlation identifies the native acceptance that
owns its messages. Loading restores those messages before input validation and
inbox projection. JSON field order is not event identity; all event values and
array order are preserved. Uncorrelated input keeps its full body for dispatch
recovery. Log-only events, other local mutations and fork constructor annotations
remain application-owned.
The catalog prefix carries the owned-event count for revision checks without
reading event bodies. The complete log length is derived from the owned-event
positions and native source map when loading; it is not stored as another count.
Native projection catch-up cannot change the owned-event count. The decoder
validates dense ownership and bounded positions before exposing the restored log.
Cold recovery indexes accepted operations by their application sequence. Native
sources can point to earlier accepted operations in a different order. A
temporary byte per application position distinguishes native from local events
while recovering a mixed log.
Cold recovery uses the event array itself to distinguish occupied positions
while merging native history. Only inbox acceptances can carry an older input
operation that needs normalization. A log with no native queue transitions
requires no inbox projection.

Cold loading validates source content and rebuilds the same dense application log
before exposing it. The reader transfers its privately parsed document to the
Session owner. The owner checks the original DSH lossless JSON rules, freezes
that graph, and shares its application events with the restored Session.
Callers retaining their own writable recovery data receive a detached snapshot.
Missing or changed native history is an error, never a reason
to substitute a cached body. Restoration uses the same native read batch as the
first observation. Older documents are validated and normalized once: version 1
uses its complete log, and version 1/2 input invocations must agree exactly with
their accepted event before their duplicate body is removed. Successful native
reconciliation rewrites them as version 8; failed validation cannot replace the
document. Version 3/4 input recovery descriptors and version 5 correlated inputs
retain their existing meaning. Versions 1–6 retain their per-event hash checks
until successful native reconciliation. Version 7 retains its per-position
correlation checks and native prefix digest. Older catalog hints acquire their owned count
when that existing reconciliation rewrites the document.

The supplied persistence writer must atomically replace that document. A flush
resolves once a snapshot containing its revision is durable. While that writer
is busy, flushes for newer revisions share the next snapshot. The writer takes
that snapshot when the previous attempt settles. A failed write leaves accepted
memory intact and a later flush may retry. Loading validates the complete
document through the selected DSH event codec and reference rules before exposing it. The existing
Session event budget applies, and a persisted document is bounded at 128 MiB.

The application profile stores these snapshots in its private selection state,
using the original DSH atomic writer. That writer owns parent creation and
replacement; newly created directories request mode `0700` and files `0600`
(subject to the platform and umask). Native-only read mirrors need no durable
application file; once a local event exists, its source map and later observations
are flushed as well. Existing files are rewritten even if their only local data
is creation metadata. The Host retires its application process before starting a
replacement. A configured application profile owns one writer. Live readers and
Agents retain their shared owner; inactive owners may be collected and reopened
from disk. Unchanged native cuts reuse the retained projector. New cuts project
only their source delta. Encoding visits local events and source/operation metadata,
not native message bodies. The in-memory dense Session remains bounded by the
Session budget; lazy in-memory history and incremental persistence remain separate work.

## Queue replacements in saved journals

A native queue replacement keeps its slot. The workbench presents the same
DSH message ID and position for an edit, with a new native acceptance ID for
mutation and claim. A journal records the end of any previously published
source prefix that presented replacements as fresh insertions. Replay keeps
those published events intact and applies slot semantics to new controls.

DSH writes `error.info` and `presentationMeta` to the Session's
`tool/result` event as `error` and `meta`. Both adapters retain those fields
under `metadata.dsh` on the native Tool result. History restores the fields
from the committed Fact, including an explicitly null presentation. The
model receives the original rendered content.

The workbench serves these recorded events through the published
`session.events` method and its `session.page` alias. Both return the
inclusive cursor of the read. Omitting `throughSeq` selects the observed
end, and `beforeSeq` pages backwards within that cut.

# Application Session journal

The compact metadata prefix includes the committed event count. Along with
the native Fact and control watermarks it identifies a Session log revision
without opening the event body. Older prefixes acquire a count on their next
publication.

`SessionProjectionJournal` owns the application event log shared by attached
Agents, workbench history and cold persistence. Native Kernel owns execution.
The attached Agent's model-selection append and the ordinary workbench model
selector both use this log and its native command driver.

Plugins read the model-visible messages with `session.deriveMessages()`.
It returns a fresh list in the release surface's order, with its replacements
and empty-message rules applied. `deriveEventMessage(event)` uses the same
surface interpreter. A full `snapshotEvents()` read shares a frozen snapshot
until the log advances. Previously returned arrays retain their original cut.

`session.observeEvent` registers a passive listener before returning `ready`.
It can subscribe before a Session exists. It reads no baseline and starts no
Agent or native history wait. Events from the registered Session's Cordis
scope retain their original sequence. On creation, the listener includes
events appended after that Session's `firstLiveSeq`, excluding restored
history. Cancellation or owner disposal removes the listener.

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

The original message-feedback service owns rating validation, version comparison
and no-op detection. Its `feedback/message-put` and `feedback/message-delete`
events are log-only application events in this same journal. Live writes use
the attached Session; cold writes use the persistence write handle. Both flush
before reporting success and survive cold replay without another feedback store
or a copy of the native transcript.

The original `/feedback <text>` command and `sessionFeedback.record` Remote
append `feedback/record` to this same journal. The event is log-only and does not
enter model context or trigger a Turn. The Remote accepts a live Session and
acknowledges synchronous acceptance; normal Session publication owns the later
flush. A missing live Session returns the original `session-not-found` result.
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
parent Turn. Reference-free `working-directory/change` and
`subagent/descriptor` events supplied at the end of the inherited prefix
belong to the constructor. The journal keeps their order, times and payloads
immediately before the child's tagged `session/end-seed`. They count as
inherited events for DSH projections and have no native Fact position.
Cold replay uses the same boundary. A child created before these events
were recorded has only the metadata present in its log.
Already prepared invocation metadata is installed before synchronous observers
see its event. Readiness walks the journal's event-position index only through
the boundary captured by the calling mutation, retaining progress across calls.
Observer errors cannot undo acceptance or prevent later events, and reentrant
mutations are rejected before modifying the log. Native observation batches are
validated as a whole before publication.
Source-map additions and changed mutation records are staged as a delta; a live
delta does not copy the retained source map, enumerate settled mutations or take
a full event snapshot. Existing immutable events are read by position. Validation
failure leaves all three logs unchanged. A batch that only acknowledges existing
local events does not construct a new Session branch or Surface manager.
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
Within one native projection, references to the same decoded inline evidence
reuse its parsed value. Weak keys follow the lifetime of that page's evidence
objects, so projection does not retain old pages or build a second transcript.
Each reference still checks its earlier Fact coordinate, section, byte count
and digest binding. The inline text and digest identify the memoized decode;
changed input crosses validation again. Shared schema subtrees become immutable
at their first event admission. A new projection has a new decoder, with no
cross-Session or durable evidence cache.
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
object; other values are encoded and hashed independently. A cold journal still
compares its saved digest against the reconstructed native event.

Each consumed native event retains its source position, content digest and
application position. Digests verify that the same source prefix has not changed;
they are not a runtime-version compatibility gate. Surface positions, source
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

Version 6 snapshots contain the Session header, owned and inherited event counts,
local-owned events at their original positions, the native source map and mutation
records in one JSON document. Native-only event bodies are reconstructed from the
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

Cold loading validates source hashes and rebuilds the same dense application log
before exposing it. Missing or changed native history is an error, never a reason
to substitute a cached body. Restoration uses the same native read batch as the
first observation. Older documents are validated and normalized once: version 1
uses its complete log, and version 1/2 input invocations must agree exactly with
their accepted event before their duplicate body is removed. Successful native
reconciliation rewrites them as version 6; failed validation cannot replace the
document. Version 3/4 input recovery descriptors and version 5 correlated inputs
retain their existing meaning. Older catalog hints acquire their owned count
when that existing reconciliation rewrites the document.
No second durable format or body cache is maintained alongside version 6.

The supplied persistence writer
must atomically replace that document. Flushes serialize snapshots in acceptance
order; equal pending flushes join. A failed write leaves accepted memory intact
and a later flush may retry. Loading validates the complete document through the
selected DSH event codec and reference rules before exposing it. The existing
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

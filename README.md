# RSIversi DSH plugins

Two packages run original DeepSeek Harness plugins inside an RSI-owned process
generation. `rsi-dsh-cordis` owns loading, dependency identity, imports and
transport. `rsi-dsh-plugin-bridge` owns the application workbench, market
operations and the Todo/Plan Agent adapter. RSI owns durable Session state.

BeforeStep receives settled tool messages through the captured native Fact
history. The DSH waterfall can edit, reorder, repeat, add or drop messages and
reject the batch. Model requests and restored DSH history use the same
committed result.

The Agent reference uses the selected installed DSH cohort. Build receipts record
source, lockfile, tools and artifact hashes for provenance; compatibility follows
the installed packages' service and peer contracts.

The [runtime contract](docs/runtime.md) owns installation, process and Session
semantics. The [browser contract](docs/browser.md) owns document composition.

Implementation and acceptance evidence are separate. Passing the standalone
adapter tests does not establish installation into a released RSI executable.

`node fixtures/market/probe-native-start.mjs RSI_BINARY NEW_HOME WEB_ASSETS`
installs an isolated Application process using the real application Session
adapter and a deterministic local provider. It verifies startup, paged submission
of 1 MiB escaped native-valid text, exact durable acceptance readback, and
idempotent same-message submission. The probe uses the repository's esbuild
development dependency to find its static imports and packages the original
modules at their source-relative paths. The new Home retains hashes and results.
Hashing the native executable uses bounded memory, including for debug builds.
The fixture closes its provider and stops the Host it attempted to launch.
Installation failures retain the package manager's diagnostic. Market fixtures select config, data,
state, cache and scratch below the chosen Home, including when reopening it.
Their native Host reads personal instructions, agents and skills from the
fixture configuration directory. Workspace-local discovery still uses the
workspace selected for the session.

### Market integration verification

`npm run test:market` exercises the transport, request boundary, real DSH Plugin
Manager and package subprocess, Tool capture, replacement and rollback. Set
`RSI_DSH_MARKET_COHORT` to the absolute path of a complete installed DSH cohort
containing the original manager, `dshmarket` and
`@deepseek-ai/dsh-experimental-claude-code-mods` (PowerShell):

```powershell
$env:RSI_DSH_MARKET_COHORT='D:/path/to/installed-cohort'
npm run test:market
```

The command requires that cohort and uses temporary profiles. It does not
download dependencies or read model credentials. A missing cohort fails before
tests start; an invalid or incomplete cohort fails the integration tests.
Acceptance requires every selected test to execute and pass. The ordinary
`npm test` command permits cohort-dependent tests to skip when the environment
variable is absent; those skips are not integration acceptance.
The acceptance runner fails on skipped, todo, failed or empty test results.
It discovers the market test directory and includes transport, application
replacement, Tool listener and workbench settings tests. Explicit test file
arguments select a narrower run under the same no-skip rule.

### Market workbench

The market workbench runs the release's web shell and Plugin Manager. In
**Plugins → Add plugin**, enter a published npm specification, or select the
Awesome index in Discover and install a plugin. Choose **Enable now**
to activate it. To use the community market, install and enable `dshmarket`
in Discover, then install the desired plugin from its own catalog. Both
interfaces write to the same selected RSI Home and restore their profile at
the next launch.

The private WebServer accepts the Host's authenticated HTTP requests at the
original path or under `/document`. Fetch resources receive the original path
and query on either mount. In-process resource reads retain the Peer supplied by
their caller. DSH owns method handling, cancellation and response streaming.

For a source comparison, build DSH at the [comparison revision](docs/runtime.md)
and pack its built public workspace packages with its workspace pnpm. From the
bridge checkout, use the resulting tarball directory (`$archives`), an unpacked
npm distribution (`$npmRoot`), and fresh output paths. The DSH version comes
from its CLI manifest. With PowerShell:

```powershell
$version = (Get-Content "$dshSource/apps/cli/package.json" -Raw | ConvertFrom-Json).version
node scripts/resolve-market-fixture.mjs $cohort $version "$npmRoot/bin/npm-cli.js" --from $archives --runtime-only
node scripts/package-market.mjs $cohort $shards
node scripts/select-market-runtime.mjs $shards $selection $npmRoot
node scripts/build-market-document.mjs $rsiReleaseWeb $document $rsiSource
node fixtures/market/stage-home.mjs $rsiBinary $marketHome $shards $selection $document
```

This Home starts with the original manager and an empty selection of third-party
plugins. Install a package by name to exercise the same path a user takes.

The market entry document ships its own HTML, JavaScript and hash receipt. It
uses the selected release's build family and Desktop protocol descriptor. After
browser authentication, the original DSH WebServer serves the workbench under
`/document/`.

Open the paired document from the staged market Home (PowerShell):

```powershell
& $rsiBinary --config-home "$marketHome/config/rsi" --data-home "$marketHome/data/rsi" --state-home "$marketHome/state/rsi" --cache-home "$marketHome/cache/rsi" --tmp-home "$marketHome/tmp" web --assets "$document"
```

### Agent reference profile

To try a built server plugin with the installed pair, use the native executable
path for Node (PowerShell example):

```powershell
$node = (Get-Command node.exe).Source
rsi plugin install --local ./artifacts/rsi-dsh-cordis ./artifacts/rsi-dsh-plugin-bridge
rsi plugin install --importer rsi-dsh-plugin-bridge/import --program $node ./my-built-plugin
```

The last command prints the ordinary package resolution. Select the generated
`dsh-import-…` name, its exact digest and its `process` export in the Agent
preset; add `rsi.extension.agent` with null configuration. The selected process
generation owns code identity, while the journal retains its committed data. Run
`node scripts/agent-preset.mjs PACKAGE DIGEST` to print that profile with the
locally discovered Node executable (or supply its absolute path as the last
argument). Save it as the chosen preset's `agent.profile.toml`. The
[workbench fixture](fixtures/workbench/serve.mjs) uses the same producer. The separately selected application supplies the browser
document. Registry packages use the same import command with a package
specification in place of the built directory.

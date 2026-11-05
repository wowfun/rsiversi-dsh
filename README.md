# RSIversi DSH plugins

Two packages run original DeepSeek Harness plugins inside an RSI-owned process
generation. `rsi-dsh-cordis` owns loading, dependency identity, imports and
transport. `rsi-dsh-plugin-bridge` owns the application workbench, market
operations and the Todo/Plan Agent adapter. RSI owns durable Session state.

BeforeStep receives settled tool messages through the captured native Fact
history. The DSH waterfall can edit, reorder, repeat, add or drop messages and
reject the batch. Model requests and restored DSH history use the same
committed result.

The legacy Agent reference was built from **ce7073d51254c26cd63b22a60835b8f948deb447** of
DeepSeek Harness, built and packed without source edits. Its version strings do
not identify its bytes; the older `dsh-v0.2.2-alpha.2` tag is not interchangeable.
Build receipts record source, lockfile, tools and artifact hashes.

The [runtime contract](docs/runtime.md) owns installation, process and Session
semantics. The [browser contract](docs/browser.md) owns document composition.

Implementation and acceptance evidence are separate. Passing the standalone
adapter tests does not establish installation into a released RSI executable.

### Market workbench

The market workbench runs the release's web shell and Plugin Manager. In
Discover, select the Awesome index and install a plugin. Choose **Enable now**
to activate it. To use the community market, install and enable `dshmarket`
in Discover, then install the desired plugin from its own catalog. Both
interfaces write to the same selected RSI Home and restore their profile at
the next launch.

The private WebServer accepts the Host's authenticated HTTP requests at the
original path or under `/document`. Fetch resources receive the original path
and query on either mount. In-process resource reads retain the Peer supplied by
their caller. DSH owns method handling, cancellation and response streaming.

For a local acceptance Home, [stage-home.mjs](fixtures/market/stage-home.mjs)
accepts the native RSI executable, a new Home, the release shard directory,
the runtime selection directory produced by `select-market-runtime.mjs`
and the paired browser document directory, in that order. The producer
takes the release shard directory, a new output directory and the published
npm package directory. It emits separate application, importer and npm
manifests. The fixture installs the
runtime and selects the market service profile. Open the paired document
from that Home (PowerShell, with `$marketHome` and `$document` set to the
paths used above):

```powershell
rsi --config-home "$marketHome/config/rsi" --state-home "$marketHome/state/rsi" --cache-home "$marketHome/cache/rsi" web --assets "$document"
```

Both target plugins can then be installed through the markets.

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
preset; bind `rsi.extension.agent` to the same digest. Run
`node scripts/agent-preset.mjs PACKAGE DIGEST` to print that profile with the
locally discovered Node executable (or supply its absolute path as the last
argument). Save it as the chosen preset's `agent.profile.toml`. The
[workbench fixture](fixtures/workbench/serve.mjs) uses the same producer. The separately selected application supplies the browser
document. Registry packages use the same import command with a package
specification in place of the built directory.

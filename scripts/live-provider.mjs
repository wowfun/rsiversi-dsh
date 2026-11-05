/** Explicit live opt-in. This verifies provider/original-tool compatibility, not RSI execution. */
import { open, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBridge } from '../packages/rsi-dsh-plugin-bridge/src/index.mjs';

const [environmentFile, outputDirectory] = process.argv.slice(2);
if (!environmentFile || !outputDirectory) throw new Error('explicit environment file and evidence directory required');
const handle = await open(resolve(environmentFile), 'r');
let secretFile;
try {
  const buffer = Buffer.alloc(64 * 1024 + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (length > 64 * 1024) throw new Error('environment file capacity');
  secretFile = buffer.toString('utf8', 0, length);
} finally { await handle.close(); }
const match = /^DEEPSEEK_API_KEY\s*=\s*(.*?)\s*$/m.exec(secretFile);
const key = match?.[1].replace(/^(['"])(.*)\1$/, '$2');
if (!key) throw new Error('DEEPSEEK_API_KEY is missing');
const bridge = await createBridge({ cohortRoot: resolve('.local/cohort') });
const id = 'live-original-todo';
const canonical = { header: { version: 4, id, createdAt: Date.now(), isSeeded: false }, events: [], revision: 0 };
await bridge.load(canonical);
const model = process.env.RSI_DSH_LIVE_MODEL ?? 'deepseek-flash';
const start = Date.now();
try {
  const schemas = await bridge.describe(id);
  const todo = schemas.find(tool => tool.name === 'todo_write');
  if (!todo) throw new Error('original Todo schema missing');
  const body = { model, max_tokens: 2048, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Call todo_write exactly once. Record two tasks: Read source (completed), Verify native plugin (in_progress). This is a test; do not perform any other work.' }],
    tools: [{ type: 'function', function: todo }], tool_choice: { type: 'function', function: { name: 'todo_write' } } };
  const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`live provider HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw new Error('live response capacity');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const returned = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  const calls = returned.choices?.[0]?.message?.tool_calls;
  if (calls?.length !== 1 || calls[0].function.name !== 'todo_write') throw new Error('live provider did not return the requested original Tool');
  const args = JSON.parse(calls[0].function.arguments);
  const staged = await bridge.tool(id, calls[0].id, 'todo_write', args);
  if (bridge.project(id).values.todos !== null) throw new Error('tentative live result leaked');
  await bridge.receipt(id, calls[0].id, staged.token, 'committed', 1);
  const state = bridge.canonical(id);
  const restored = await createBridge({ cohortRoot: resolve('.local/cohort') });
  try {
    await restored.load(state);
    if (JSON.stringify(restored.project(id)) !== JSON.stringify(bridge.project(id))) throw new Error('live result recovery mismatch');
  } finally { await restored.close(); }
  const receipt = { scope: 'live provider -> original schema -> original Todo -> simulated canonical receipt -> restart; not RSI Kernel execution',
    model: returned.model, responseId: returned.id, elapsedMs: Date.now() - start, usage: returned.usage,
    tool: calls[0].function.name, arguments: args, result: staged.payload.result, event: staged.payload.suffix[0],
    token: staged.token, restored: true };
  await mkdir(resolve(outputDirectory), { recursive: true });
  await writeFile(resolve(outputDirectory, 'live-original-todo.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ model: receipt.model, tool: receipt.tool, elapsedMs: receipt.elapsedMs, restored: true }));
} finally { await bridge.close(); }

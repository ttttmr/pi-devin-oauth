import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const bundleDir = await mkdtemp(join(tmpdir(), "pi-devin-context-test-"));
await build({
  entryPoints: ["src/chat-context-map.ts", "src/context-budget.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outdir: bundleDir,
  logLevel: "silent",
});
const contextMap = await import(pathToFileURL(join(bundleDir, "chat-context-map.js")).href);
const contextBudget = await import(pathToFileURL(join(bundleDir, "context-budget.js")).href);

test.after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

test("projects resumed system messages before mapping and token budgeting", () => {
  const context = {
    messages: [
      {
        role: "system",
        content: "base instructions",
        sections: { rules: "<rules>current rules</rules>", removed: null },
        toolsAdded: [
          { name: "read", description: "Read a file", parameters: {} },
          { name: "write", description: "Write a file", parameters: {} },
        ],
        timestamp: 1,
      },
      {
        role: "system",
        content: "",
        sections: { rules: "<rules>updated rules</rules>" },
        toolsRemoved: [{ name: "write" }],
        toolsAdded: [{ name: "write", description: "Write a file (updated)", parameters: {} }],
        timestamp: 2,
      },
      { role: "user", content: "Continue after resume.", timestamp: 3 },
    ],
    tools: [],
  };

  const normalized = contextMap.normalizeContextForDevin(context);
  assert.equal(
    normalized.systemPrompt,
    "base instructions\n\n<rules>updated rules</rules>",
  );
  assert.deepEqual(normalized.messages.map((message) => message.role), ["user"]);
  assert.deepEqual(normalized.tools, [
    { name: "read", description: "Read a file", parameters: {} },
    { name: "write", description: "Write a file (updated)", parameters: {} },
  ]);

  const mapped = contextMap.mapContextToChat(context);
  assert.equal(mapped.systemPrompt, normalized.systemPrompt);
  assert.deepEqual(mapped.messages, [{ role: "user", content: "Continue after resume." }]);
  assert.deepEqual(mapped.tools, [
    { name: "read", description: "Read a file", parameters: {} },
    { name: "write", description: "Write a file (updated)", parameters: {} },
  ]);

  const model = { contextWindow: 100_000 };
  assert.equal(contextBudget.clampMaxTokensForDevin(model, context, 123), 123);

  const smallContext = {
    messages: [
      { role: "system", content: "x".repeat(400), timestamp: 1 },
      { role: "user", content: "ok", timestamp: 2 },
    ],
    tools: [],
  };
  assert.equal(contextBudget.clampMaxTokensForDevin({ contextWindow: 4_500 }, smallContext, 1_000), 303);
});

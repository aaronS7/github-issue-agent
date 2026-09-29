import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { defineCommand } from "just-bash";
import { runAgent } from "../src/agent.js";
import { createConfiguredModel, ScriptedModel } from "../src/model.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "issue-agent-test-"));
  cleanup.push(path);
  return path;
}

test("edits files through just-bash and records bounded events", async () => {
  const root = await workspace();
  const events: string[] = [];
  const result = await runAgent({
    workspace: root,
    prompt: "Create a note.",
    model: new ScriptedModel([
      { script: "printf 'hello from agent\\n' > note.txt" },
      { script: "cat note.txt" },
      { text: "Created note.txt and verified its contents." },
    ]),
    onEvent: (event) => { events.push(event.type); },
  });
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "hello from agent\n");
  assert.equal(result.steps, 2);
  assert.equal(result.summary, "Created note.txt and verified its contents.");
  assert.deepEqual(events, ["command", "command", "final"]);
  assert.equal(result.transcript[1]?.type, "command");
  if (result.transcript[1]?.type === "command") assert.equal(result.transcript[1].stdout, "hello from agent\n");
});

test("capability commands compose with pipes and redirection", async () => {
  const root = await workspace();
  let guarded = 0;
  const result = await runAgent({
    workspace: root,
    prompt: "Use the greeting command.",
    model: new ScriptedModel([
      { script: "agent-tools" },
      { script: "hello world | tr a-z A-Z > greeting.txt" },
      { text: "Wrote a greeting." },
    ]),
    capabilities: [{
      name: "hello",
      description: "Print a greeting",
      create: ({ assertActive }) => defineCommand("hello", async ([name]) => {
        await assertActive();
        return { stdout: `hello ${name ?? "friend"}\n`, stderr: "", exitCode: 0 };
      }),
    }],
    beforeCommand: async () => { guarded++; },
  });
  assert.equal(await readFile(join(root, "greeting.txt"), "utf8"), "HELLO WORLD\n");
  assert.ok(guarded >= 3);
  assert.equal(result.steps, 2);
  const help = result.transcript[0];
  assert.equal(help?.type, "command");
  if (help?.type === "command") assert.match(help.stdout, /hello\s+Print a greeting/);
});

test("cannot read or overwrite a file through an escaping symlink", async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "secret"), "keep me");
  await symlink(join(outside, "secret"), join(root, "escape"));
  const result = await runAgent({
    workspace: root,
    prompt: "Try paths.",
    model: new ScriptedModel([
      { script: "cat escape" },
      { script: "printf changed > escape" },
      { script: "npm --version" },
      { text: "The paths were blocked." },
    ]),
  });
  assert.equal(await readFile(join(outside, "secret"), "utf8"), "keep me");
  for (const event of result.transcript.slice(0, 3)) {
    assert.equal(event.type, "command");
    if (event.type === "command") assert.notEqual(event.exitCode, 0);
  }
});

test("step limit and lease guard prevent further writes", async () => {
  const root = await workspace();
  await assert.rejects(runAgent({
    workspace: root,
    prompt: "Keep going.",
    model: new ScriptedModel([{ script: "touch first" }, { script: "touch second" }]),
    maxSteps: 1,
  }), /maxSteps/);
  assert.equal(await readFile(join(root, "first"), "utf8"), "");
  await assert.rejects(runAgent({
    workspace: root,
    prompt: "Write a file.",
    model: new ScriptedModel([{ script: "touch denied" }]),
    beforeCommand: async () => { throw new Error("lease lost"); },
  }), /lease lost/);
  await assert.rejects(readFile(join(root, "denied"), "utf8"));
});

test("multiple bash calls in one model turn run separately and count against maxSteps", async () => {
  const root = await workspace();
  const result = await runAgent({
    workspace: root, prompt: "Make and read a file.", maxSteps: 2,
    model: new ScriptedModel([
      { scripts: ["printf 'first\\n' > feature.txt", "cat feature.txt"] },
      { text: "Created and read the feature." },
    ]),
  });
  assert.equal(result.steps, 2);
  assert.deepEqual(result.transcript.slice(0, 2).map((event) => event.type === "command" ? event.step : null), [1, 2]);
  assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "first\n");
  await assert.rejects(runAgent({
    workspace: root, prompt: "Too many calls.", maxSteps: 1,
    model: new ScriptedModel([{ scripts: ["touch should-not-exist", "pwd"] }]),
  }), /maxSteps/);
  await assert.rejects(readFile(join(root, "should-not-exist"), "utf8"));
});

test("aborted runs stop before a command", async () => {
  const root = await workspace();
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(runAgent({
    workspace: root,
    prompt: "Write a file.",
    model: new ScriptedModel([{ script: "touch denied" }]),
    signal: controller.signal,
  }), /cancelled/);
  await assert.rejects(readFile(join(root, "denied"), "utf8"));
});

test("configured model exposes only the bash tool", async () => {
  let requestBody: any;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "bash", arguments: '{"script":"pwd"}' } },
            { id: "call_2", type: "function", function: { name: "bash", arguments: '{"script":"ls"}' } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = createConfiguredModel({
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test",
    });
    const decision = await model.complete([{ role: "user", content: "Where am I?" }], new AbortController().signal);
    assert.deepEqual(decision.scripts, ["pwd", "ls"]);
    assert.deepEqual(requestBody.tools.map((entry: { function: { name: string } }) => entry.function.name), ["bash"]);
  } finally {
    server.close();
  }
});

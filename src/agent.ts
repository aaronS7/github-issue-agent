import { realpath, stat } from "node:fs/promises";
import { Bash, ReadWriteFs, defineCommand, type CustomCommand } from "just-bash";
import type { AgentMessage, AgentModel } from "./model.js";

export interface AgentCapabilityContext {
  signal: AbortSignal;
  /** Check the durable job lease immediately before an external side effect. */
  assertActive: () => Promise<void>;
}

export interface AgentCapability {
  name: string;
  description: string;
  create: (context: AgentCapabilityContext) => CustomCommand;
}

export interface AgentCommandEvent {
  type: "command";
  step: number;
  script: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
}

export interface AgentFinalEvent {
  type: "final";
  summary: string;
  steps: number;
}

export type AgentEvent = AgentCommandEvent | AgentFinalEvent;
export type AgentTraceEvent = AgentEvent |
  { type: "model-start"; call: number } |
  { type: "model-end"; call: number; durationMs: number; outcome: "scripts" | "final" | "error"; usage?: { inputTokens?: number; outputTokens?: number }; error?: string } |
  { type: "command-start"; step: number; script: string } |
  { type: "command-error"; step: number; durationMs: number; error: string } |
  { type: "capability-start"; name: string } |
  { type: "capability-end"; name: string; durationMs: number; exitCode?: number; error?: string };

export interface RunAgentOptions {
  workspace: string;
  prompt: string;
  model: AgentModel;
  capabilities?: AgentCapability[];
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  beforeCommand?: () => Promise<void>;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  /** Additional timing events. The legacy transcript and onEvent stay command/final-only. */
  onTrace?: (event: AgentTraceEvent) => Promise<void> | void;
}

export interface AgentRunResult {
  summary: string;
  steps: number;
  transcript: AgentEvent[];
}

const MAX_SCRIPT_CHARS = 64_000;
const MAX_RECORDED_OUTPUT_CHARS = 8_000;
const MAX_MESSAGE_HISTORY = 16;
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function limited(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated ${value.length - max} characters]`;
}

function isRecoverableFileError(error: unknown): error is Error {
  return error instanceof Error &&
    /^(?:EACCES|EPERM|ENOENT|EISDIR|ENOTDIR|EEXIST|EFBIG|EROFS):/.test(error.message);
}

function validateCapabilities(capabilities: AgentCapability[]): void {
  const seen = new Set<string>(["agent-tools"]);
  for (const capability of capabilities) {
    if (!NAME_PATTERN.test(capability.name) || seen.has(capability.name)) {
      throw new Error(`Invalid or duplicate agent capability: ${capability.name}`);
    }
    seen.add(capability.name);
  }
}

function createSystemMessage(capabilities: AgentCapability[]): string {
  const available = capabilities.length
    ? capabilities.map(({ name, description }) => `- ${name}: ${description}`).join("\n")
    : "- No external capabilities are available.";
  return [
    "You are an issue implementation agent working in a bounded, writable project workspace.",
    "The only tool available to you is bash. Use it to inspect and edit project files.",
    "The shell is just-bash: its built-in file and text commands work, but host binaries, git, package managers, network access, Python, and JavaScript execution are unavailable.",
    "Each bash call starts in / and has fresh shell variables; file changes persist across calls.",
    "Use `agent-tools` to see available capability commands. They compose with pipes and redirection like other shell commands.",
    "When finished, give a concise explanation of the changes and any validation performed as a final answer without a bash call.",
    "Available capability commands:\n" + available,
  ].join("\n\n");
}

/** Run a single issue agent. Guest code reaches the workspace only through just-bash. */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const maxSteps = options.maxSteps ?? 30;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be a positive integer");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  if (!options.prompt.trim()) throw new Error("Agent prompt is empty");

  const capabilities = options.capabilities ?? [];
  validateCapabilities(capabilities);
  const workspace = await realpath(options.workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error("Agent workspace must be a directory");

  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relayAbort();
  else options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Agent deadline exceeded")), timeoutMs);
  timer.unref?.();
  const signal = controller.signal;
  const assertActive = async () => {
    signal.throwIfAborted();
    await options.beforeCommand?.();
    signal.throwIfAborted();
  };

  try {
    const fs = new ReadWriteFs({
      root: workspace,
      allowSymlinks: false,
      maxFileReadSize: 10 * 1024 * 1024,
      maxCopySize: 32 * 1024 * 1024,
    });
    const customCommands: CustomCommand[] = [
      defineCommand("agent-tools", async () => ({
        stdout: capabilities.length
          ? capabilities.map(({ name, description }) => `${name}\t${description}`).join("\n") + "\n"
          : "No external capability commands are available.\n",
        stderr: "",
        exitCode: 0,
      })),
      ...capabilities.map((capability) => {
        const command = capability.create({ signal, assertActive });
        if (command.name !== capability.name || !("execute" in command)) {
          throw new Error(`Capability ${capability.name} created a command with a different name or a lazy loader`);
        }
        return {
          ...command,
          execute: async (...args: Parameters<typeof command.execute>) => {
            await assertActive();
            const started = performance.now();
            await options.onTrace?.({ type: "capability-start", name: capability.name });
            try {
              const result = await command.execute(...args);
              await options.onTrace?.({ type: "capability-end", name: capability.name,
                durationMs: performance.now() - started, exitCode: result.exitCode });
              return result;
            } catch (error) {
              await options.onTrace?.({ type: "capability-end", name: capability.name,
                durationMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) });
              throw error;
            }
          },
        };
      }),
    ];
    const bash = new Bash({
      fs,
      cwd: "/",
      env: { HOME: "/", PATH: "/bin:/usr/bin", LANG: "C.UTF-8" },
      python: false,
      javascript: false,
      executionLimitProfile: "hardened",
      executionLimits: {
        maxExecutionTimeMs: Math.min(timeoutMs, 30_000),
        maxCommandCount: 2_000,
        maxSourceBytes: MAX_SCRIPT_CHARS,
        maxOutputSize: 64 * 1024,
        maxArchiveBytes: 32 * 1024 * 1024,
      },
      customCommands,
    });
    const messages: AgentMessage[] = [
      { role: "system", content: createSystemMessage(capabilities) },
      { role: "user", content: options.prompt },
    ];
    const transcript: AgentEvent[] = [];

    let steps = 0;
    let modelCalls = 0;
    while (true) {
      signal.throwIfAborted();
      const call = ++modelCalls;
      const modelStarted = performance.now();
      await options.onTrace?.({ type: "model-start", call });
      let decision;
      try { decision = await options.model.complete(messages, signal); }
      catch (error) {
        await options.onTrace?.({ type: "model-end", call, durationMs: performance.now() - modelStarted,
          outcome: "error", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      await options.onTrace?.({ type: "model-end", call, durationMs: performance.now() - modelStarted,
        outcome: decision.script !== undefined || decision.scripts?.length ? "scripts" : "final",
        ...(decision.usage ? { usage: decision.usage } : {}) });
      signal.throwIfAborted();
      if (decision.script !== undefined && decision.scripts !== undefined) {
        throw new Error("Model returned both script and scripts");
      }
      const scripts = decision.script !== undefined ? [decision.script] : decision.scripts ?? [];
      if (scripts.length) {
        if (scripts.length > maxSteps - steps) {
          throw new Error(`Agent exceeded maxSteps (${maxSteps}) without a final answer`);
        }
        for (const script of scripts) {
          if (!script.trim()) throw new Error("Model returned an empty bash script");
          if (script.length > MAX_SCRIPT_CHARS) throw new Error("Model bash script exceeds size limit");
          await assertActive();
          const commandStarted = performance.now();
          await options.onTrace?.({ type: "command-start", step: steps + 1, script });
          let output: { stdout: string; stderr: string; exitCode: number };
          try {
            output = await bash.exec(script, { signal, rawScript: true });
            signal.throwIfAborted();
          } catch (error) {
            if (!signal.aborted && isRecoverableFileError(error)) {
              output = { stdout: "", stderr: error.message, exitCode: 1 };
            } else {
              const failure = signal.aborted ? signal.reason : error;
              await options.onTrace?.({ type: "command-error", step: steps + 1,
                durationMs: performance.now() - commandStarted,
                error: failure instanceof Error ? failure.message : String(failure) });
              throw failure;
            }
          }
          const event: AgentCommandEvent = {
            type: "command",
            step: ++steps,
            script,
            stdout: limited(output.stdout, MAX_RECORDED_OUTPUT_CHARS),
            stderr: limited(output.stderr, MAX_RECORDED_OUTPUT_CHARS),
            exitCode: output.exitCode,
            durationMs: performance.now() - commandStarted,
          };
          transcript.push(event);
          await options.onEvent?.(event);
          await options.onTrace?.(event);
          messages.push({ role: "assistant", content: `bash script:\n${script}` });
          messages.push({ role: "user", content: `bash result (exit ${event.exitCode}):\nstdout:\n${event.stdout}\nstderr:\n${event.stderr}` });
          if (messages.length > MAX_MESSAGE_HISTORY + 2) messages.splice(2, messages.length - MAX_MESSAGE_HISTORY - 2);
        }
        continue;
      }
      const summary = decision.text?.trim();
      if (!summary) throw new Error("Model returned neither a bash call nor a final answer");
      const event: AgentFinalEvent = { type: "final", summary: limited(summary, 16_000), steps };
      transcript.push(event);
      await options.onEvent?.(event);
      await options.onTrace?.(event);
      return { summary: event.summary, steps: event.steps, transcript };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

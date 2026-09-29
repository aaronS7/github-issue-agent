import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One model turn: execute one or more bash calls, or give the final answer. */
export interface AgentDecision {
  script?: string;
  scripts?: string[];
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AgentModel {
  complete(messages: readonly AgentMessage[], signal: AbortSignal): Promise<AgentDecision>;
}

export interface ModelConfig {
  provider: "anthropic" | "openai-compatible";
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

/** The model sees exactly one tool. Additional operations are shell commands. */
export function createConfiguredModel(config: ModelConfig): AgentModel {
  if (!config.model.trim()) throw new Error("Model name is required");
  let languageModel: LanguageModel;
  if (config.provider === "anthropic") {
    const anthropic = createAnthropic({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    languageModel = anthropic(config.model);
  } else if (config.provider === "openai-compatible") {
    if (!config.baseUrl) throw new Error("baseUrl is required for openai-compatible models");
    const compatible = createOpenAICompatible({
      name: "issue-agent",
      baseURL: config.baseUrl,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
    languageModel = compatible(config.model);
  } else {
    throw new Error(`Unsupported model provider: ${String(config.provider)}`);
  }

  const bashInput = z.object({ script: z.string().min(1).max(64_000) });
  const bashTool = {
    description: "Run a bash script inside the isolated issue workspace. Use built-in shell commands and installed capability commands; host binaries and network are unavailable.",
    inputSchema: bashInput,
  };

  return {
    async complete(messages, signal) {
      const result = await generateText({
        model: languageModel,
        messages: [...messages],
        tools: { bash: bashTool },
        toolChoice: "auto",
        abortSignal: signal,
        maxRetries: 2,
      });
      const calls = result.toolCalls.filter((call) => call.toolName === "bash");
      if (calls.length !== result.toolCalls.length) throw new Error("Model returned an unknown tool call");
      const scripts = calls.map((call) => bashInput.parse(call.input).script);
      const usage = {
        ...(result.usage.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
        ...(result.usage.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
      };
      if (scripts.length === 1) return { script: scripts[0]!, usage };
      if (scripts.length > 1) return { scripts, usage };
      return { text: result.text, usage };
    },
  };
}

/** Deterministic offline model for demos and integration tests. */
export class ScriptedModel implements AgentModel {
  private index = 0;

  constructor(private readonly decisions: readonly AgentDecision[]) {}

  async complete(_messages: readonly AgentMessage[], signal: AbortSignal): Promise<AgentDecision> {
    signal.throwIfAborted();
    const decision = this.decisions[this.index++];
    if (!decision) throw new Error("ScriptedModel has no remaining decisions");
    return decision;
  }
}

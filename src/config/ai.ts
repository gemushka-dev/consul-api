import OpenAI from 'openai';
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { env } from './env.js';

export type ThinkingMode = 'disabled' | 'enabled' | 'auto';

export interface KimiChatOptions {
  temperature?: number;
  thinking?: { type: 'disabled' | 'enabled' };
}

export function isKimiModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('kimi') || lower.includes('moonshot');
}

export function hasAiApiKey(): boolean {
  return Boolean(env.AI_API_KEY && env.AI_API_KEY.trim().length > 0);
}

export function createAiClient(timeoutMs: number = env.AI_TIMEOUT_MS): OpenAI {
  return new OpenAI({
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    timeout: timeoutMs,
  });
}

/**
 * Returns Moonshot / Kimi K3-safe sampling and thinking parameters:
 * - Thinking enabled: enforces temperature=1.0 (required by Kimi reasoning models)
 * - Thinking disabled: fast instant mode with temperature=0.6 for crisp tool calling & <8s latency
 * - Thinking auto: omits explicit temperature/thinking so Moonshot applies exact model defaults
 * - Non-Kimi models: uses caller's fallbackTemperature
 */
export function getModelChatOptions(
  model: string,
  thinkingMode: ThinkingMode = env.AI_THINKING,
  fallbackTemperature = 0.2,
): KimiChatOptions {
  if (!isKimiModel(model)) {
    return { temperature: fallbackTemperature };
  }

  if (thinkingMode === 'enabled') {
    return {
      temperature: 1.0,
      thinking: { type: 'enabled' },
    };
  }

  if (thinkingMode === 'disabled') {
    return {
      temperature: 0.6,
      thinking: { type: 'disabled' },
    };
  }

  return {};
}

type KimiAssistantMessage = ChatCompletionMessage & {
  reasoning_content?: string | null;
};

/**
 * Preserves `reasoning_content` on assistant tool-call messages when iterating multi-step
 * function calls on Kimi K3 / Moonshot thinking models.
 */
export function buildAssistantToolCallMessage(
  msg: ChatCompletionMessage,
): ChatCompletionMessageParam {
  const kimiMsg = msg as KimiAssistantMessage;
  const param: Record<string, unknown> = {
    role: 'assistant',
    content: msg.content ?? '',
    tool_calls: msg.tool_calls,
  };
  if (typeof kimiMsg.reasoning_content === 'string') {
    param.reasoning_content = kimiMsg.reasoning_content;
  }
  return param as unknown as ChatCompletionMessageParam;
}

/**
 * Extracts raw JSON string from markdown-fenced model output (e.g. ```json ... ```).
 */
export function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced && fenced[1] ? fenced[1].trim() : trimmed;
}

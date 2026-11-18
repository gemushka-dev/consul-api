import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import {
  buildAssistantToolCallMessage,
  getModelChatOptions,
  isKimiModel,
  stripJsonCodeFences,
} from '../src/config/ai.js';
import { env } from '../src/config/env.js';

describe('Kimi K3 (Moonshot AI) Adapter & Defaults', () => {
  it('defaults to Moonshot API base URL and kimi-k3 for chat and vision', () => {
    expect(env.AI_BASE_URL).toBe('https://api.moonshot.ai/v1');
    expect(env.AI_MODEL).toBe('kimi-k3');
    expect(env.AI_VISION_MODEL).toBe('kimi-k3');
    expect(env.AI_THINKING).toBe('disabled');
    expect(isKimiModel('kimi-k3')).toBe(true);
    expect(isKimiModel('kimi-k3.1-pro')).toBe(true);
  });

  it('applies Kimi-safe temperature and thinking options without violating Moonshot rules', () => {
    expect(getModelChatOptions('kimi-k3', 'disabled')).toEqual({
      temperature: 0.6,
      thinking: { type: 'disabled' },
    });
    expect(getModelChatOptions('kimi-k3', 'enabled')).toEqual({
      temperature: 1.0,
      thinking: { type: 'enabled' },
    });
    expect(getModelChatOptions('kimi-k3', 'auto')).toEqual({});
    expect(getModelChatOptions('deepseek-chat', 'disabled', 0.2)).toEqual({
      temperature: 0.2,
    });
  });

  it('preserves reasoning_content on assistant tool-call turns for Kimi multi-step tool calling', () => {
    const fakeMsg = {
      role: 'assistant',
      content: null,
      refusal: null,
      reasoning_content: 'Need to call get_today before answering.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_today', arguments: '{}' },
        },
      ],
    } as unknown as ChatCompletionMessage;

    const built = buildAssistantToolCallMessage(fakeMsg) as unknown as Record<string, unknown>;
    expect(built.role).toBe('assistant');
    expect(built.reasoning_content).toBe('Need to call get_today before answering.');
    expect(built.tool_calls).toHaveLength(1);
  });

  it('strips markdown json fences from Kimi structured responses', () => {
    const raw = '```json\n{"text":"ok","card":null}\n```';
    expect(JSON.parse(stripJsonCodeFences(raw))).toEqual({ text: 'ok', card: null });
  });
});

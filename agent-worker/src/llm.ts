import { config } from './config.js';
import { httpFetch } from './http.js';

export interface LlmResult {
  body: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmChatResult {
  content: string;
  toolCalls: LlmToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * 通用多轮 Chat Completions（3.3.3 Tool Use）。
 * 接收完整 messages 数组与可选 tools 定义；当模型返回 tool_calls 时一并返回，
 * 供 worker 执行工具后追加结果再次调用，实现 function-calling 多轮循环。
 */
export async function callLlmChat(opts: {
  messages: LlmMessage[];
  model: string;
  temperature: number;
  maxTokens: number;
  tools?: unknown[];
}): Promise<LlmChatResult> {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY is not set');
  }

  const model = opts.model || config.llmModel || 'gpt-4o-mini';
  const url = `${config.llmBaseUrl}/chat/completions`;

  const payload: Record<string, unknown> = {
    model,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    messages: opts.messages,
  };
  if (opts.tools && opts.tools.length > 0) {
    payload.tools = opts.tools;
    payload.tool_choice = 'auto';
  }

  const res = await httpFetch(url, {
    method: 'POST',
    label: 'llm',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as any;
  const message = json?.choices?.[0]?.message ?? {};
  const toolCalls: LlmToolCall[] = Array.isArray(message?.tool_calls)
    ? message.tool_calls
        .filter((t: any) => t?.function?.name)
        .map((t: any) => ({
          id: String(t.id || ''),
          type: 'function',
          function: {
            name: String(t.function.name),
            arguments: String(t.function.arguments || '{}'),
          },
        }))
    : [];

  return {
    content: String(message?.content || '').trim(),
    toolCalls,
    promptTokens: json?.usage?.prompt_tokens,
    completionTokens: json?.usage?.completion_tokens,
  };
}

export async function callLlm(opts: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
}): Promise<LlmResult> {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY is not set');
  }

  const model = opts.model || config.llmModel || 'gpt-4o-mini';
  const url = `${config.llmBaseUrl}/chat/completions`;

  const res = await httpFetch(url, {
    method: 'POST',
    label: 'llm',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as any;
  const body = String(json?.choices?.[0]?.message?.content || '').trim();
  if (!body) throw new Error('empty LLM response');

  return {
    body,
    promptTokens: json?.usage?.prompt_tokens,
    completionTokens: json?.usage?.completion_tokens,
  };
}

/**
 * 流式（SSE）Chat Completions（3.2.3）。
 * 逐 chunk 解析 OpenAI 兼容的 `data: {json}\n\n` 帧，累加 delta 文本并回调 onDelta，
 * 返回与 callLlm 一致的 LlmResult（usage 可能缺失，取决于上游是否在末帧给出）。
 */
export async function callLlmStream(
  opts: {
    systemPrompt: string;
    userPrompt: string;
    model: string;
    temperature: number;
    maxTokens: number;
  },
  onDelta: (acc: string, delta: string) => void,
): Promise<LlmResult> {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY is not set');
  }

  const model = opts.model || config.llmModel || 'gpt-4o-mini';
  const url = `${config.llmBaseUrl}/chat/completions`;

  const res = await httpFetch(url, {
    method: 'POST',
    label: 'llm-stream',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM stream ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let acc = '';
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  const handleFrame = (frame: string) => {
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = String(json?.choices?.[0]?.delta?.content || '');
      if (delta) {
        acc += delta;
        onDelta(acc, delta);
      }
      if (json?.usage) {
        promptTokens = json.usage.prompt_tokens ?? promptTokens;
        completionTokens = json.usage.completion_tokens ?? completionTokens;
      }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      handleFrame(frame);
    }
  }
  if (buffer.trim()) handleFrame(buffer);

  const body = acc.trim();
  if (!body) throw new Error('empty LLM response');
  return { body, promptTokens, completionTokens };
}

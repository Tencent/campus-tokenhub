/**
 * 增量 SSE 解析。
 *
 * 只解决三件事：跨 chunk 切断的行要拼回来、多行 data 要合并、`[DONE]` 要终止。
 * 单条 data 解析失败只上报错误，不终止整条流（上游偶发脏数据不该让整页卡死）。
 */

export type SSEHandlers = {
  onData?: (data: string, event: string | null) => void;
  onDone?: () => void;
  /** 收到无法解析的 data 时回调，调用方自行决定是否提示 */
  onParseError?: (data: string) => void;
};

export type SSEParser = {
  push: (chunk: string) => void;
  flush: () => void;
};

export function createSSEParser(handlers: SSEHandlers = {}): SSEParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | null = null;
  let finished = false;

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventName = null;
      return;
    }
    const data = dataLines.join('\n');
    const name = eventName;
    dataLines = [];
    eventName = null;

    if (data === '[DONE]') {
      if (!finished) {
        finished = true;
        handlers.onDone?.();
      }
      return;
    }
    handlers.onData?.(data, name);
  };

  const handleLine = (line: string): void => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    // id / retry 用不上
  };

  const drain = (): void => {
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      handleLine(line);
      index = buffer.indexOf('\n');
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      drain();
    },
    flush(): void {
      if (buffer.trim() !== '') {
        handleLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      dispatch();
    },
  };
}

export type ChatDelta = { content: string; reasoning: string; usage?: unknown; finishReason?: string | null };

/** 把一条 OpenAI 流式 data 解析成增量；脏数据返回 null 而不是抛错。 */
export function parseChatChunk(data: string): ChatDelta | null {
  try {
    const json = JSON.parse(data) as {
      choices?: {
        delta?: { content?: string | null; reasoning_content?: string | null };
        message?: { content?: string | null; reasoning_content?: string | null };
        finish_reason?: string | null;
      }[];
      usage?: unknown;
    };
    const choice = json.choices?.[0];
    const delta = choice?.delta ?? choice?.message;
    return {
      content: delta?.content ?? '',
      reasoning: delta?.reasoning_content ?? '',
      usage: json.usage,
      finishReason: choice?.finish_reason ?? null,
    };
  } catch {
    return null;
  }
}

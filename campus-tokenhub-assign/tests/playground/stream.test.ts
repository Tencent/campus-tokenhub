import { describe, expect, it, vi } from 'vitest';
import { createSSEParser, parseChatChunk } from '@/lib/playground/stream';

function collect() {
  const events: { data: string; event: string | null }[] = [];
  const parser = createSSEParser({
    onData: (data, event) => events.push({ data, event }),
    onDone: () => events.push({ data: '[DONE]', event: 'done' }),
    onParseError: (data) => events.push({ data, event: 'error' }),
  });
  return { parser, events };
}

describe('createSSEParser', () => {
  it('逐块输入，增量回调', () => {
    const { parser, events } = collect();

    parser.push('data: {"a":1}\n\n');
    parser.push('data: {"a":2}\n\n');

    expect(events).toEqual([
      { data: '{"a":1}', event: null },
      { data: '{"a":2}', event: null },
    ]);
  });

  it('分块边界切断一条 data 时不丢字符', () => {
    const { parser, events } = collect();

    parser.push('data: {"content":"你');
    parser.push('好"}\n\n');

    expect(events[0].data).toBe('{"content":"你好"}');
  });

  it('[DONE] 终止且只回调一次', () => {
    const { parser, events } = collect();

    parser.push('data: {"a":1}\n\n');
    parser.push('data: [DONE]\n\n');
    parser.push('data: [DONE]\n\n');

    expect(events.filter((event) => event.event === 'done')).toHaveLength(1);
  });

  it('多行 data 合并成一条', () => {
    const { parser, events } = collect();

    parser.push('data: line1\ndata: line2\n\n');

    expect(events[0].data).toBe('line1\nline2');
  });

  it('注释行与 event 名被正确处理', () => {
    const { parser, events } = collect();

    parser.push(': keep-alive\n');
    parser.push('event: message\ndata: {"a":1}\n\n');

    expect(events).toEqual([{ data: '{"a":1}', event: 'message' }]);
  });

  it('flush 会吐出没有结尾空行的最后一条', () => {
    const { parser, events } = collect();

    parser.push('data: {"a":1}');
    parser.flush();

    expect(events[0].data).toBe('{"a":1}');
  });
});

describe('parseChatChunk', () => {
  it('取出正文与 reasoning_content', () => {
    expect(
      parseChatChunk('{"choices":[{"delta":{"content":"你","reasoning_content":"想"}}],"usage":{"total_tokens":3}}')
    ).toEqual({ content: '你', reasoning: '想', usage: { total_tokens: 3 }, finishReason: null });
  });

  it('非流式 message 形状也能解析', () => {
    expect(parseChatChunk('{"choices":[{"message":{"content":"完整"},"finish_reason":"stop"}]}')).toMatchObject({
      content: '完整',
      finishReason: 'stop',
    });
  });

  it('脏数据返回 null 而不抛错', () => {
    const onData = vi.fn();
    const parser = createSSEParser({ onData });

    expect(parseChatChunk('not json')).toBeNull();
    parser.push('data: not json\n\n');

    expect(onData).toHaveBeenCalledWith('not json', null);
  });
});

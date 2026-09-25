import { describe, expect, it } from 'vitest';
import { createLineSplitter, encodeLlmEvent, normalizeLlmBaseUrl, parseLlmEvent, type LlmStreamEvent } from './llm';

/**
 * A등급 — **테스트 먼저** (3절, P10_설계서_Llm D.1·FR-1104).
 *
 * 흐름의 줄은 서버가 쓰고 화면이 읽는다. 둘이 같은 함수를 쓰므로 여기서 한 번 고정하면 양쪽이 같이 고정된다.
 */

describe('encodeLlmEvent — 한 줄에 하나 (D.1)', () => {
  it('JSON 한 줄과 줄바꿈 하나다', () => {
    expect(encodeLlmEvent({ type: 'ping' })).toBe('{"type":"ping"}\n');
  });

  it('**답에 든 줄바꿈이 줄을 나누지 않는다** — JSON이 이스케이프한다', () => {
    const line = encodeLlmEvent({ type: 'delta', text: '첫 줄\n둘째 줄' });
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(parseLlmEvent(line.trimEnd())).toEqual({ type: 'delta', text: '첫 줄\n둘째 줄' });
  });
});

describe('createLineSplitter — 조각이 줄 가운데서 끊겨 와도 된다', () => {
  it('완성된 줄만 내고 나머지는 들고 있는다', () => {
    const s = createLineSplitter();
    expect(s.push('{"type":"ping"}\n{"type":"de')).toEqual(['{"type":"ping"}']);
    expect(s.push('lta","text":"a"}\n')).toEqual(['{"type":"delta","text":"a"}']);
    expect(s.end()).toEqual([]);
  });

  it('CRLF도 같게 나누고 빈 줄은 버린다', () => {
    const s = createLineSplitter();
    expect(s.push('a\r\n\r\nb\n')).toEqual(['a', 'b']);
  });

  it('끝날 때 남은 줄이 있으면 낸다 — 마지막 줄에 줄바꿈이 없어도 잃지 않는다', () => {
    const s = createLineSplitter();
    expect(s.push('a\nb')).toEqual(['a']);
    expect(s.end()).toEqual(['b']);
    expect(s.end()).toEqual([]);
  });

  it('한 조각에 여러 줄이 와도 차례대로 낸다', () => {
    expect(createLineSplitter().push('1\n2\n3\n')).toEqual(['1', '2', '3']);
  });
});

describe('parseLlmEvent — 모양이 맞는 것만 받는다', () => {
  const ok: LlmStreamEvent[] = [
    { type: 'delta', text: '답' },
    { type: 'thinking', text: '생각' },
    { type: 'ping' },
    { type: 'end', status: 'done', saved: true, conversationId: '00000000-0000-4000-8000-000000000000', evicted: 0, message: null },
    { type: 'end', status: 'failed', saved: false, conversationId: null, evicted: 0, message: 'LLM 서버에 닿지 않는다' },
    { type: 'end', status: 'stopped', saved: true, conversationId: '00000000-0000-4000-8000-000000000000', evicted: 2, message: null },
  ];

  it.each(ok)('$type 줄을 되읽는다', (e) => {
    expect(parseLlmEvent(encodeLlmEvent(e).trimEnd())).toEqual(e);
  });

  it('JSON이 아니면 null', () => {
    expect(parseLlmEvent('{')).toBeNull();
    expect(parseLlmEvent('그냥 글자')).toBeNull();
    expect(parseLlmEvent('null')).toBeNull();
    expect(parseLlmEvent('[1]')).toBeNull();
  });

  it('모르는 종류는 null', () => {
    expect(parseLlmEvent('{"type":"html","text":"<b>"}')).toBeNull();
  });

  it('글자가 문자열이 아니면 null', () => {
    expect(parseLlmEvent('{"type":"delta","text":1}')).toBeNull();
    expect(parseLlmEvent('{"type":"thinking"}')).toBeNull();
  });

  it('**끝 줄은 모든 칸을 본다** — 화면이 이 줄로 저장 여부를 판단한다', () => {
    const base = { type: 'end', status: 'done', saved: true, conversationId: null, evicted: 0, message: null };
    expect(parseLlmEvent(JSON.stringify(base))).not.toBeNull();
    expect(parseLlmEvent(JSON.stringify({ ...base, status: 'weird' }))).toBeNull();
    expect(parseLlmEvent(JSON.stringify({ ...base, saved: 'yes' }))).toBeNull();
    expect(parseLlmEvent(JSON.stringify({ ...base, conversationId: 3 }))).toBeNull();
    expect(parseLlmEvent(JSON.stringify({ ...base, evicted: -1 }))).toBeNull();
    expect(parseLlmEvent(JSON.stringify({ ...base, evicted: 1.5 }))).toBeNull();
    expect(parseLlmEvent(JSON.stringify({ ...base, message: 5 }))).toBeNull();
  });
});

describe('normalizeLlmBaseUrl — 주소 판정 (FR-1104)', () => {
  const good = (raw: string) => {
    const r = normalizeLlmBaseUrl(raw);
    if (!r.ok) throw new Error(r.reason);
    return r.url;
  };
  const bad = (raw: string) => {
    const r = normalizeLlmBaseUrl(raw);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.reason;
  };

  it('http(s)와 포트·경로는 그대로 둔다', () => {
    expect(good('http://llm.example.internal:8000/v1')).toBe('http://llm.example.internal:8000/v1');
    expect(good('https://llm.example.internal/v1')).toBe('https://llm.example.internal/v1');
  });

  it('앞뒤 공백과 **끝의 `/`를 뗀다** — 뒤에 `/chat/completions`를 붙인다', () => {
    expect(good('  http://llm.example.internal:8000/v1/  ')).toBe('http://llm.example.internal:8000/v1');
    expect(good('http://llm.example.internal:8000/v1///')).toBe('http://llm.example.internal:8000/v1');
    expect(good('http://llm.example.internal:8000/')).toBe('http://llm.example.internal:8000');
  });

  it('스킴과 호스트의 대소문자는 URL 규칙대로 소문자가 된다', () => {
    expect(good('HTTP://LLM.Example.Internal:8000/v1')).toBe('http://llm.example.internal:8000/v1');
  });

  it('http(s)가 아니면 거부한다', () => {
    expect(bad('ftp://llm.example.internal/v1')).toMatch(/http/);
    expect(bad('javascript:alert(1)')).toMatch(/http/);
    expect(bad('file:///etc/passwd')).toMatch(/http/);
  });

  it('**주소에 사용자 정보를 받지 않는다** — 키가 주소에 섞여 화면·감사로그로 나간다', () => {
    expect(bad('http://user:pass@llm.example.internal/v1')).toMatch(/사용자 정보/);
    expect(bad('http://user@llm.example.internal/v1')).toMatch(/사용자 정보/);
  });

  it('질의·조각을 받지 않는다 — `?key=`로 키를 넣는 길을 막는다', () => {
    expect(bad('http://llm.example.internal/v1?key=abc')).toMatch(/질의/);
    expect(bad('http://llm.example.internal/v1#x')).toMatch(/조각/);
  });

  it('주소 모양이 아니면 거부한다', () => {
    expect(bad('llm.example.internal/v1')).toMatch(/주소/);
    expect(bad('')).toMatch(/주소/);
    expect(bad('http://')).toMatch(/주소/);
  });

  it('너무 길면 거부한다', () => {
    expect(bad(`http://llm.example.internal/${'a'.repeat(600)}`)).toMatch(/길/);
  });
});

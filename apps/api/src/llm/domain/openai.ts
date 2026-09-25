/**
 * OpenAI 호환 형식 읽고 쓰기 (A등급, P10_설계서_Llm D.2).
 *
 * 사내 LLM 서버(vLLM)의 `/chat/completions` 흐름은 SSE다 — `data: {조각}` 줄과 빈 줄, 끝은 `data: [DONE]`.
 * **실연동 확인은 보류 29다.** 여기 모양은 vLLM이 내는 OpenAI 호환 형식에서 온 가정이고, 틀리면 이 파일과 어댑터만 고친다.
 */

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

/** 보내는 몸통. 흘려보내기를 켜고 마지막 조각에 토큰 수를 달라고 한다 */
export function buildChatRequest(model: string, messages: ChatMessage[]): Record<string, unknown> {
  return { model, messages, stream: true, stream_options: { include_usage: true } };
}

/**
 * SSE를 이벤트의 자료(`data`)로 나눈다 (SSE 규칙의 필요한 만큼).
 *
 * - 줄 끝은 LF·CRLF·CR. **CR로 끝난 조각 다음 조각이 LF로 시작하면 그 LF는 앞 줄의 끝이다** — 빈 줄을 하나 더 만들지 않는다
 * - `:`로 시작하는 줄은 주석(살아 있음), `event`·`id`·`retry` 칸은 버린다
 * - `data` 줄이 여럿이면 줄바꿈으로 잇고, 빈 줄에서 이벤트 하나를 낸다
 * - 빈 줄 없이 흐름이 끝나도 마지막 이벤트를 잃지 않는다(`end`)
 */
export function createSseParser(): { push(text: string): string[]; end(): string[] } {
  let buffer = '';
  let skipLf = false;
  let data: string[] = [];

  const line = (l: string, out: string[]) => {
    if (l === '') {
      if (data.length) out.push(data.join('\n'));
      data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  };

  return {
    push(text: string): string[] {
      const out: string[] = [];
      // 빈 조각은 건너뛴다 — 아니면 "CR 다음의 LF를 건너뛴다"는 기억이 빈 조각에서 지워진다
      if (!text) return out;
      let s = text;
      if (skipLf && s.startsWith('\n')) s = s.slice(1);
      skipLf = false;
      buffer += s;
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buffer);
        if (!m) break;
        // 조각이 CR로 끝나면 다음 조각의 LF와 한 줄 끝일 수 있다 — 지금 줄은 끝내고, 다음 조각 앞의 LF를 건너뛴다
        if (m[0] === '\r' && m.index === buffer.length - 1) skipLf = true;
        line(buffer.slice(0, m.index), out);
        buffer = buffer.slice(m.index + m[0].length);
      }
      return out;
    },
    end(): string[] {
      const out: string[] = [];
      if (buffer) line(buffer, out);
      buffer = '';
      line('', out);
      return out;
    },
  };
}

export type ChatChunk = {
  /** 답의 조각 */
  answer: string;
  /** 생각 과정의 조각 — vLLM reasoning parser가 `reasoning_content`(옛)나 `reasoning`(새)에 싣는다 (FR-1119) */
  thinking: string;
  finish: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  /** 흐름 안에서 온 오류. 있으면 그 흐름은 실패다 */
  error: string | null;
  /** `[DONE]` */
  done: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 오류 본문의 두 모양 — `{"object":"error","message":…}`(vLLM)과 `{"error":{"message":…}}`(OpenAI) */
function errorMessageOf(v: Record<string, unknown>): string | null {
  if (isRecord(v.error) && typeof v.error.message === 'string') return v.error.message;
  if (v.object === 'error' && typeof v.message === 'string') return v.message;
  return null;
}

/** 조각 하나(`data`의 값)를 읽는다. **JSON이 아니면 오류다** — 모르는 것을 답으로 보여 주지 않는다 */
export function readChatChunk(data: string): ChatChunk {
  const empty: ChatChunk = { answer: '', thinking: '', finish: null, usage: null, error: null, done: false };
  if (data.trim() === '[DONE]') return { ...empty, done: true };
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return { ...empty, error: 'LLM 응답을 읽을 수 없다' };
  }
  if (!isRecord(v)) return { ...empty, error: 'LLM 응답을 읽을 수 없다' };
  const err = errorMessageOf(v);
  if (err !== null) return { ...empty, error: err };

  const out = { ...empty };
  const choice = Array.isArray(v.choices) && isRecord(v.choices[0]) ? v.choices[0] : null;
  if (choice) {
    const delta = isRecord(choice.delta) ? choice.delta : {};
    out.answer = str(delta.content);
    out.thinking = str(delta.reasoning_content) || str(delta.reasoning);
    out.finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  }
  if (isRecord(v.usage) && typeof v.usage.prompt_tokens === 'number' && typeof v.usage.completion_tokens === 'number') {
    out.usage = { promptTokens: v.usage.prompt_tokens, completionTokens: v.usage.completion_tokens };
  }
  return out;
}

/** 화면에 말하는 까닭의 길이 (FR-1120) */
const ERROR_MESSAGE_MAX = 300;

/**
 * 거절의 까닭 (FR-1120). JSON 오류 모양이면 그 메시지를 줄여서, **아니면 상태 코드만** — 프록시의 HTML 오류 쪽을 화면에
 * 쏟지 않는다. 이 값은 화면으로 가고 **로그에는 가지 않는다**(남의 응답이라 무엇이 들었는지 모른다).
 */
export function readErrorMessage(status: number, body: string): string {
  let message: string | null = null;
  try {
    const v: unknown = JSON.parse(body);
    if (isRecord(v)) message = errorMessageOf(v) ?? (typeof v.message === 'string' ? v.message : null);
  } catch {
    message = null;
  }
  if (!message) return `HTTP ${status}`;
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > ERROR_MESSAGE_MAX ? `${oneLine.slice(0, ERROR_MESSAGE_MAX - 1)}…` : oneLine;
}

/** 모델 목록(`GET /models`)의 `data[].id` (FR-1105). 모양이 아니면 `null` */
export function readModelIds(body: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  return body.data.filter(isRecord).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

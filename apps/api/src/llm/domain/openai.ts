import { LLM_LIMITS } from '@workfluence/shared';

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

/** SSE 한 줄·한 이벤트가 상한(`LLM_LIMITS.sseLineMaxChars`)을 넘었다 — 어댑터가 "읽을 수 없는 응답"으로 바꾼다 */
export class SseOverflowError extends Error {
  constructor() {
    super('SSE 한 줄이나 한 이벤트가 상한을 넘었다');
    this.name = 'SseOverflowError';
  }
}

/**
 * SSE를 이벤트의 자료(`data`)로 나눈다 (SSE 규칙의 필요한 만큼).
 *
 * - 줄 끝은 LF·CRLF·CR. **CR로 끝난 조각 다음 조각이 LF로 시작하면 그 LF는 앞 줄의 끝이다** — 빈 줄을 하나 더 만들지 않는다
 * - `:`로 시작하는 줄은 주석(살아 있음), `event`·`id`·`retry` 칸은 버린다
 * - `data` 줄이 여럿이면 줄바꿈으로 잇고, 빈 줄에서 이벤트 하나를 낸다
 * - 빈 줄 없이 흐름이 끝나도 마지막 이벤트를 잃지 않는다(`end`)
 * - **한 줄과 한 이벤트에 상한이 있다** — 넘으면 `SseOverflowError`. 줄바꿈 없는 줄이 끝없이 오면 답 상한과 무관하게 메모리가 늘고,
 *   조각마다 버퍼를 처음부터 다시 훑으면 제곱으로 느려진다 — 새로 붙은 부분만 훑는다 (검토 반영 — 보안 검토 1)
 */
export function createSseParser(): { push(text: string): string[]; end(): string[] } {
  let buffer = '';
  /** 줄 끝을 찾을 곳 — 앞 조각에서 이미 훑은 자리는 다시 훑지 않는다 */
  let scanFrom = 0;
  let skipLf = false;
  let data: string[] = [];
  let dataChars = 0;

  const line = (l: string, out: string[]) => {
    if (l === '') {
      if (data.length) out.push(data.join('\n'));
      data = [];
      dataChars = 0;
      return;
    }
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataChars += value.length + 1;
      if (dataChars > LLM_LIMITS.sseLineMaxChars) throw new SseOverflowError();
      data.push(value);
    }
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
      const lineEnd = /\r\n|\r|\n/g;
      let start = 0;
      lineEnd.lastIndex = scanFrom;
      for (;;) {
        const m = lineEnd.exec(buffer);
        if (!m) break;
        // 조각이 CR로 끝나면 다음 조각의 LF와 한 줄 끝일 수 있다 — 지금 줄은 끝내고, 다음 조각 앞의 LF를 건너뛴다
        if (m[0] === '\r' && m.index === buffer.length - 1) skipLf = true;
        line(buffer.slice(start, m.index), out);
        start = m.index + m[0].length;
      }
      buffer = buffer.slice(start);
      scanFrom = buffer.length;
      if (buffer.length > LLM_LIMITS.sseLineMaxChars) throw new SseOverflowError();
      return out;
    },
    end(): string[] {
      const out: string[] = [];
      if (buffer) line(buffer, out);
      buffer = '';
      scanFrom = 0;
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
  /**
   * 그 오류가 **읽을 수 없는 조각**이다(JSON이 아니거나 객체가 아니다) — LLM 서버의 거절이 아니라 응답의 모양이 틀렸다. 감사·로그의
   * 실패 종류가 `protocol`이 되게 가른다 (종료 루틴 자체 점검 5)
   */
  malformed: boolean;
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

/**
 * 남의 문장을 화면에 말할 모양으로 — 공백을 모아 한 줄로, `LLM_LIMITS.errorMessageMaxChars`자까지. 비었으면 `null`.
 * HTTP 오류 본문과 흐름 안의 오류가 같은 규칙을 쓴다 (검토 반영 — 코드 리뷰 4)
 */
function shortMessage(message: string): string | null {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  const max = LLM_LIMITS.errorMessageMaxChars;
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** 조각 하나(`data`의 값)를 읽는다. **JSON이 아니면 오류다** — 모르는 것을 답으로 보여 주지 않는다 */
export function readChatChunk(data: string): ChatChunk {
  const empty: ChatChunk = { answer: '', thinking: '', finish: null, usage: null, error: null, malformed: false, done: false };
  if (data.trim() === '[DONE]') return { ...empty, done: true };
  const unreadable: ChatChunk = { ...empty, error: 'LLM 응답을 읽을 수 없다', malformed: true };
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return unreadable;
  }
  if (!isRecord(v)) return unreadable;
  const err = errorMessageOf(v);
  if (err !== null) return { ...empty, error: shortMessage(err) ?? 'LLM 서버가 도중에 거절했다' };

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
  return (message && shortMessage(message)) || `HTTP ${status}`;
}

/**
 * **문맥 초과 거절인가** (D.3·FR-1120). vLLM은 `This model's maximum context length is … tokens`로 거절한다. 다른 게이트웨이의
 * 흔한 문장도 본다. 실제 문장은 보류 29에서 확인한다
 */
export function isContextOverflow(message: string): boolean {
  return /maximum context length|context (length|window)|too many tokens|prompt is too long/i.test(message);
}

/**
 * 거절을 화면에 말하는 문장. 문맥 초과면 **"새 대화를 시작한다"를 앞에** 둔다 — 같은 대화에서 다시 보내면 매번 같게 실패한다.
 * LLM 서버의 문장은 뒤에 붙여 남긴다
 */
export function rejectionText(message: string): string {
  return isContextOverflow(message) ? `대화가 모델이 한 번에 읽을 수 있는 길이를 넘었다 — 새 대화를 시작한다 (LLM 서버: ${message})` : message;
}

/**
 * 남의 문장에서 API 키를 가린다 — 게이트웨이가 받은 키를 거절 문장에 되읊으면 그 문장이 **모든 사용자의 화면**에 나간다
 * (검토 반영 — 보안 검토). 아주 짧은 키(6자 미만)는 가리지 않는다 — 평범한 글자를 지우게 된다
 */
export function redactSecret(text: string, secret: string | null): string {
  if (!secret || secret.length < 6) return text;
  return text.split(secret).join('***');
}

/** 모델 목록(`GET /models`)의 `data[].id` (FR-1105). 모양이 아니면 `null` */
export function readModelIds(body: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  return body.data.filter(isRecord).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

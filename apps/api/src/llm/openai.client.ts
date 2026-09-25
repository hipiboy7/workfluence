import { Injectable } from '@nestjs/common';
import { LLM_LIMITS } from '@workfluence/shared';
import {
  SseOverflowError,
  buildChatRequest,
  createSseParser,
  readChatChunk,
  readErrorMessage,
  readModelIds,
  redactSecret,
  rejectionText,
  type ChatMessage,
} from './domain/openai';
import { createThinkSplitter } from './domain/think';
import { LlmError, type LlmChunk, type LlmClient, type LlmTarget } from './llm.provider';

/**
 * OpenAI 호환 어댑터 (P10_설계서_Llm D.2) — vLLM의 `/chat/completions`·`/models`.
 *
 * - **넘겨주기(redirect)를 따르지 않는다.** 따르면 API 키가 등록하지 않은 곳으로 간다
 * - 응답 본문을 **로그에 담지 않는다** — 남의 응답이라 무엇이 들었는지 모른다(`mail/http.sender.ts`와 같은 판단).
 *   까닭은 줄여서 호출부에 넘기고, 호출부는 화면에만 말한다
 * - 요청은 Node 내장 `fetch`다 — 새 운영 의존성을 들이지 않는다 (NFR-104)
 *
 * **실연동 확인은 보류 29다.** 시험은 가짜 LLM 서버(node:http)로 한다.
 */
@Injectable()
export class OpenAiCompatClient implements LlmClient {
  async *stream(target: LlmTarget, messages: ChatMessage[], signal: AbortSignal): AsyncIterable<LlmChunk> {
    let res: Response;
    try {
      res = await fetch(`${target.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeader(target) },
        body: JSON.stringify(buildChatRequest(target.model, messages)),
        redirect: 'error',
        signal,
      });
    } catch (e) {
      throw toLlmError(e, signal);
    }
    if (!res.ok) throw rejected(res.status, readErrorMessage(res.status, await readLimited(res, LLM_LIMITS.errorBodyMaxBytes, false)), target);
    if (!res.body) throw new LlmError('protocol', 'LLM 서버가 흐름을 보내지 않았다');
    // **흘려보내지 않는 200을 받지 않는다** — `stream`을 모르는 게이트웨이가 완성본 JSON을 주면 조각이 하나도 없어 "빈 답"이 된다
    // (검토 반영 — 코드 리뷰 4)
    if (!/text\/event-stream/i.test(res.headers.get('content-type') ?? '')) {
      await res.body.cancel().catch(() => undefined);
      throw new LlmError('protocol', 'LLM 서버가 흘려보내지 않았다 — 흘려보내기(stream)를 지원하는 OpenAI 호환 주소인지 확인한다');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const sse = createSseParser();
    const think = createThinkSplitter();
    try {
      for (;;) {
        let r: Awaited<ReturnType<typeof reader.read>>;
        try {
          r = await reader.read();
        } catch (e) {
          throw toLlmError(e, signal);
        }
        const text = r.done ? decoder.decode() : decoder.decode(r.value, { stream: true });
        let events: string[];
        try {
          events = r.done ? [...sse.push(text), ...sse.end()] : sse.push(text);
        } catch (e) {
          if (e instanceof SseOverflowError) throw new LlmError('protocol', 'LLM 응답의 한 줄이 너무 길다 — LLM 서버나 그 앞의 게이트웨이를 확인한다');
          throw e;
        }
        for (const data of events) {
          const c = readChatChunk(data);
          // 흐름 안의 오류 — 읽을 수 없는 조각이면 응답의 모양이 틀린 것(`protocol`), 아니면 모델 서버가 도중에 거절했다(그 메시지)
          if (c.error !== null) throw c.malformed ? new LlmError('protocol', c.error) : rejected(null, c.error, target);
          if (c.done) {
            yield* think.end();
            return;
          }
          if (c.thinking) yield { kind: 'thinking', text: c.thinking };
          if (c.answer) yield* think.push(c.answer);
          if (c.finish) yield { kind: 'finish', reason: c.finish };
          if (c.usage) yield { kind: 'usage', ...c.usage };
        }
        if (r.done) break;
      }
      // `[DONE]` 없이 흐름이 끝났다 — 받은 데까지는 답이다. 붙들고 있던 것을 낸다
      yield* think.end();
    } finally {
      // 다 읽기 전에 멈추면(중지·상한) **연결을 끊는다** — GPU를 놀리지 않는다 (FR-1113)
      await reader.cancel().catch(() => undefined);
    }
  }

  async listModels(target: LlmTarget, signal: AbortSignal): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${target.baseUrl}/models`, {
        headers: { accept: 'application/json', ...authHeader(target) },
        redirect: 'error',
        signal,
      });
    } catch (e) {
      throw toLlmError(e, signal);
    }
    const body = await readLimited(res, res.ok ? LLM_LIMITS.modelsBodyMaxBytes : LLM_LIMITS.errorBodyMaxBytes, res.ok);
    if (!res.ok) throw rejected(res.status, readErrorMessage(res.status, body), target);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new LlmError('protocol', '모델 목록을 읽을 수 없다 — 주소가 OpenAI 호환 API의 `/v1`까지인지 확인한다');
    }
    const ids = readModelIds(json);
    if (!ids) throw new LlmError('protocol', '모델 목록을 읽을 수 없다 — 주소가 OpenAI 호환 API의 `/v1`까지인지 확인한다');
    return ids;
  }
}

function authHeader(target: LlmTarget): Record<string, string> {
  return target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {};
}

/**
 * 거절 — 남의 문장에서 **키를 가리고**(게이트웨이가 되읊을 수 있다), 문맥 초과면 "새 대화를 시작한다"를 앞에 둔다 (FR-1120)
 */
function rejected(status: number | null, message: string, target: LlmTarget): LlmError {
  return new LlmError('rejected', rejectionText(redactSecret(message, target.apiKey)), status);
}

/**
 * 본문을 `max` 바이트까지 읽는다. 넘으면 `strict`일 때는 실패, 아니면 거기까지만 — 오류 본문은 까닭 한 줄이면 된다.
 */
async function readLimited(res: Response, max: number, strict: boolean): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > max) {
        if (strict) throw new LlmError('protocol', '응답이 너무 크다');
        parts.push(r.value.subarray(0, r.value.byteLength - (size - max)));
        break;
      }
      parts.push(r.value);
    }
  } catch (e) {
    if (e instanceof LlmError) throw e;
    // 오류 본문을 읽다 끊긴 것은 까닭을 못 읽었을 뿐이다
    if (!strict) return new TextDecoder().decode(concat(parts));
    throw new LlmError('unreachable', 'LLM 서버와의 연결이 끊겼다');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(concat(parts));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * undici(`fetch`)의 기본 시간 제한 — 머리말이 오기까지·조각 사이가 **300초**다. `WF_LLM_TIMEOUT_MS`(답 하나의 전체 상한)와 다른
 * "아무것도 안 오는 시간"의 상한이라, 그 까닭으로 말한다 (검토 반영 — 코드 리뷰 7)
 */
const UNDICI_IDLE_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/**
 * `fetch`가 던진 것을 종류로 옮긴다. **주소를 싣지 않는다** — 오류 코드(`ECONNREFUSED` 등)만. 이 까닭은 화면으로 간다.
 */
export function toLlmError(e: unknown, signal: AbortSignal): LlmError {
  if (e instanceof LlmError) return e;
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof DOMException && reason.name === 'TimeoutError') return new LlmError('timeout', '시간 상한을 넘었다');
    return new LlmError('aborted', '중지했다');
  }
  const cause = e instanceof Error ? (e.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const causeMessage = typeof cause?.message === 'string' ? cause.message : '';
  if (/redirect/i.test(causeMessage)) return new LlmError('unreachable', 'LLM 서버가 다른 주소로 넘겼다 — 넘겨주기는 따르지 않는다. 주소를 확인한다');
  if (typeof cause?.code === 'string' && UNDICI_IDLE_CODES.has(cause.code)) {
    return new LlmError('timeout', `LLM 서버가 5분 동안 아무것도 보내지 않았다 (${cause.code})`);
  }
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return new LlmError('unreachable', `LLM 서버에 닿지 않는다${code}`);
}

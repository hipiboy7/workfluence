import type { ChatMessage } from './domain/openai';

/**
 * 사내 LLM을 부르는 경계 (P10_설계서_Llm A.1-2, 2절 DIP).
 *
 * **메일 발송·인증 제공자와 같은 축이다.** 사내 LLM 앞에 다른 형식의 게이트웨이가 서면 구현 하나만 바꾼다 — 상위 로직
 * (질문 중계·저장)은 구체 구현을 import하지 않는다. 시험은 가짜 구현을 끼운다.
 *
 * 인터페이스를 **작게** 둔다 (ISP). 호출부가 필요한 것은 "흘려받기"와 "모델 목록"뿐이다.
 */
export const LLM_CLIENT = Symbol('LLM_CLIENT');

/** 부를 곳 — 등록한 LLM 하나. 키는 **풀어 둔 것**이고 질문 하나(그 답이 끝날 때까지)나 연결 확인 하나 동안만 메모리에 있다 (D.4) */
export type LlmTarget = { baseUrl: string; model: string; apiKey: string | null };

/**
 * 흘러나오는 조각 — 답·생각 과정·토큰 수, 그리고 둘:
 * - `rethink` 지금까지의 답은 생각 과정이었다(닫는 태그만 오는 모델, `domain/think.ts`)
 * - `finish` 모델이 말한 끝의 까닭(`finish_reason`). `length`면 길이 상한에서 잘린 답이다 (검토 반영 — 코드 리뷰 4)
 */
export type LlmChunk =
  | { kind: 'answer'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'rethink' }
  | { kind: 'finish'; reason: string }
  | { kind: 'usage'; promptTokens: number; completionTokens: number };

/**
 * 실패의 종류 (FR-1120). 화면이 까닭을 말하려면 종류가 있어야 한다.
 *
 * - `unreachable` 닿지 않는다 · `rejected` LLM 서버가 거절했다(그 메시지) · `protocol` 응답을 읽을 수 없다
 * - `timeout` 시간 상한 · `aborted` 중지(사용자·연결 끊김)
 */
export type LlmErrorKind = 'unreachable' | 'rejected' | 'protocol' | 'timeout' | 'aborted';

/**
 * `message`는 **화면에 말하는 문장**이다 — `rejected`면 남의 문장(키는 가렸다)이라 로그에 싣지 않는다. 로그·감사에는 `kind`와
 * `status`(HTTP 상태)만 간다
 */
export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmClient {
  /** 흘려받는다. 조각을 차례로 낸다. 실패는 `LlmError`로 던진다. `signal`이 끊기면 요청을 끊는다 */
  stream(target: LlmTarget, messages: ChatMessage[], signal: AbortSignal): AsyncIterable<LlmChunk>;
  /** 모델 목록 — 연결 확인 (FR-1105). 실패는 `LlmError` */
  listModels(target: LlmTarget, signal: AbortSignal): Promise<string[]>;
}

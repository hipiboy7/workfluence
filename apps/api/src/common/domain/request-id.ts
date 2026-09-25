import { LOG_LIMITS } from '@workfluence/shared';

/** 영문·숫자·`-`만, 정해진 길이 안에서 (P11 D.2) */
const SHAPE = new RegExp(`^[A-Za-z0-9-]{${LOG_LIMITS.requestIdMinChars},${LOG_LIMITS.requestIdMaxChars}}$`);

/**
 * 받은 요청 식별자를 쓸 수 있는가 (P11_설계서_Ops D.2, FR-1210). nginx가 `X-Request-Id`로 넘긴다(`$request_id`, 32자 16진).
 *
 * **이 값은 로그 줄에 그대로 들어간다** — 줄바꿈·따옴표를 받으면 로그 한 줄을 꾸밀 수 있다(로그 위조). 모양이 맞을 때만 쓰고,
 * 아니면 `null` — 부른 쪽이 새로 만든다. 머리말이 둘이면 첫째만 본다.
 */
export function requestIdFrom(header: unknown): string | null {
  const v: unknown = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && SHAPE.test(v) ? v : null;
}

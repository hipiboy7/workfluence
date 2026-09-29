import { MAIL_TIMEOUT_MS } from './domain/request';

/** 시험 명령이 읽는 응답 본문의 상한(바이트) — 까닭 한 줄이면 된다. 끝없는 본문을 다 읽지 않는다(코드 리뷰 10) */
export const MAIL_BODY_READ_MAX = 4096;

export type MailPostResult = { ok: boolean; status: number; body: string };

/**
 * 사내 메일 API에 요청 하나를 보낸다 (P18_설계서_Mail FR-1903) — **앱(`HttpMailSender`)과 시험 명령(`mail-test`)이 이 한 곳을 쓴다**: 시험 명령이 앱과 같은
 * 길로 보내야 시험이 뜻을 가진다(코드 리뷰 4 — 두 벌이면 한쪽만 바뀐다).
 *
 * - **넘겨주기를 따르지 않는다** — 인증 헤더가 다른 곳으로 따라가지 않게 (A.1-7)
 * - **시간 제한** `MAIL_TIMEOUT_MS` — 메일 서버가 답하지 않으면 알림 처리가 거기 묶인다(T-026). 시험은 짧게 준다
 * - 본문은 `readBody`일 때만 앞의 `MAIL_BODY_READ_MAX` 바이트까지 읽고, 아니면 비운다(연결을 오래 쥐지 않게)
 *
 * 닿지 않으면 **던진다**(`fetch`의 오류 그대로) — 받는 쪽이 로그(`errorText`)나 까닭(`failureHint`)으로 옮긴다
 */
export async function postMail(
  req: { url: string; headers: Record<string, string>; body: string },
  opts: { readBody?: boolean; timeoutMs?: number } = {},
): Promise<MailPostResult> {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
    redirect: 'error',
    signal: AbortSignal.timeout(opts.timeoutMs ?? MAIL_TIMEOUT_MS),
  });
  const body = opts.readBody ? await readHead(res) : '';
  if (!opts.readBody) await res.body?.cancel().catch(() => undefined);
  return { ok: res.ok, status: res.status, body };
}

/** 본문의 앞부분만 읽고 나머지는 버린다 */
async function readHead(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAIL_BODY_READ_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, MAIL_BODY_READ_MAX).toString('utf8');
}

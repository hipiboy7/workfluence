import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import type { MailMessage, MailSender } from './mail.provider';
import { MAIL_TIMEOUT_MS, mailConfigOf, mailRequest } from './domain/request';
import { logLine } from '../common/log-line';

/**
 * 사내 메일 API 어댑터 (P6 FR-751 → P18_설계서_Mail FR-1900~1903). 요청의 모양은 `domain/request.ts`가 만든다 — 사용자가 준 사내 API 설명 그대로다.
 *
 * - **넘겨주기를 따르지 않는다** — 인증 헤더가 다른 곳으로 따라가지 않게 (A.1-7)
 * - 2xx만 성공. **응답 본문을 로그에 담지 않는다** — 무엇이 들었는지 모르는 남의 응답이다(상태만)
 * - **던지지 않는다** — 실패는 `false` (FR-753)
 *
 * **실연동 확인은 보류 18이다** — 폐쇄망 반입 뒤 현장에서(반입 가이드 "사내 메일 연결하기"). 모의 통과는 완료가 아니다 (9.1절과 같은 판단).
 */
@Injectable()
export class HttpMailSender implements MailSender {
  private readonly log = new Logger('Mail');

  constructor(@Inject(APP_ENV) private readonly env: AppEnvToken) {}

  async send(message: MailMessage): Promise<boolean> {
    if (!this.env.WF_MAIL_API_URL) {
      // 켜 놓고 주소를 안 적은 상태다(기동 검사가 막지만 — 모의에서 바꾼 배선 등). **조용히 성공으로 치지 않는다**
      this.log.warn(logLine('mail.unconfigured', '메일이 켜져 있는데 WF_MAIL_API_URL이 비었다'));
      return false;
    }
    const req = mailRequest(mailConfigOf(this.env), message);
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        redirect: 'error',
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      });
      // 연결을 오래 쥐지 않게 본문을 비운다 — 읽은 것은 쓰지 않는다
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) {
        this.log.warn(logLine('mail.rejected', '메일 API가 받지 않았다', { status: res.status }));
        return false;
      }
      return true;
    } catch (e) {
      // 오류 문장에 주소·헤더가 섞이지 않게 공통 로거가 거른다(`errorText`) — 인증 값은 헤더라 오류 문장에 오지 않는다
      this.log.warn(logLine('mail.failed', '메일 API 호출 실패', {}, e));
      return false;
    }
  }
}

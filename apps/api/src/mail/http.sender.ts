import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import type { MailMessage, MailSender } from './mail.provider';
import { isSingleRecipient, mailConfigOf, mailRequest } from './domain/request';
import { postMail } from './post';
import { logLine } from '../common/log-line';

/**
 * 사내 메일 API 어댑터 (P6 FR-751 → P18_설계서_Mail FR-1900~1903). 요청의 모양은 `domain/request.ts`가 만든다 — 사용자가 준 사내 API 설명 그대로다.
 *
 * - 보내는 길(넘겨주기를 따르지 않는다·시간 제한)은 `post.ts` 한 곳이다 — 시험 명령과 같다
 * - **받는 사람이 주소 하나가 아니면 보내지 않는다**(`isSingleRecipient`) — 사내 API는 쉼표 목록을 여럿으로 읽는다. 사내 계정의 email은 로그인 때 받아
 *   적는다(병합 전 보안 검토 2)
 * - 2xx만 성공. **응답 본문을 로그에 담지 않는다** — 무엇이 들었는지 모르는 남의 응답이다(상태만)
 * - **던지지 않는다** — 실패는 `false` (FR-753)
 *
 * **실연동 확인은 보류 18이다** — 폐쇄망 반입 뒤 현장에서(설치및실행가이드 "사내 메일 연결하기"). 모의 통과는 완료가 아니다 (9.1절과 같은 판단).
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
    if (!isSingleRecipient(message.to)) {
      // 주소는 싣지 않는다(개인정보, 7절) — 사용자 관리에서 email에 쉼표·빈칸이 든 계정을 찾는다. 새 사내 계정은 로그인 때 걸러지므로(`freeEmail`)
      // 이것은 그 전에 들어온 값이다
      this.log.warn(logLine('mail.bad_recipient', '받는 사람이 주소 하나가 아니라 보내지 않았다'));
      return false;
    }
    try {
      // 요청을 만드는 것도 try 안이다 — "던지지 않는다"가 그 함수가 던지지 않는다는 사실에 기대지 않게(코드 리뷰 8)
      const res = await postMail(mailRequest(mailConfigOf(this.env), message));
      if (!res.ok) {
        this.log.warn(logLine('mail.rejected', '메일 API가 받지 않았다', { status: res.status }));
        return false;
      }
      return true;
    } catch (e) {
      // 오류는 공통 로거(`errorText`)가 코드와 원인 문장(호스트:포트)만 싣는다 — 인증 값은 헤더라 오류 문장에 오지 않고, 헤더 값의 글자는 기동 검사가 막는다
      this.log.warn(logLine('mail.failed', '메일 API 호출 실패', {}, e));
      return false;
    }
  }
}

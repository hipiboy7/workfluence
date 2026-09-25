import { Injectable, Logger } from '@nestjs/common';
import type { MailMessage, MailSender } from './mail.provider';
import { logLine } from '../common/log-line';

/**
 * 모의 발송 (FR-752). 보낸 내용을 로그로 남기고 **실제로 보내지 않는다.**
 *
 * 개발 서버가 사내 메일 API에 나갈 수 있는지 아직 모른다 (보류 18). 모의로 두면
 * 배선이 맞는지는 확인할 수 있고, **맞다고 착각하지는 않는다** — 로그에 `모의`라고 적는다.
 */
@Injectable()
export class MockMailSender implements MailSender {
  private readonly log = new Logger('Mail');

  send(message: MailMessage): Promise<boolean> {
    // 받는 사람 주소는 개인정보다. **도메인만 남기고 가린다** (7절 로그 규칙). **제목은 싣지 않는다** — 부른 사람의 표시 이름이 들어 있다
    // ("… 님이 회원님을 불렀습니다"). 사용자는 불투명 id로만 남긴다 (7절, P11 코드 리뷰 7)
    const masked = message.to.map((a) => a.replace(/^[^@]+/, '***'));
    this.log.log(logLine('mail.mock_sent', '모의 발송', { to: masked }));
    return Promise.resolve(true);
  }
}

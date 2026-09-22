import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import type { MentionOutcome } from '../notifications/notifications.service';
import { MAIL_SENDER, type MailSender } from './mail.provider';

/**
 * 멘션을 메일로도 알린다 (P6_설계서_Collab FR-750·753~756).
 *
 * **트랜잭션 밖에서 부른다** (FR-754). 호출부가 커밋한 뒤에 이것을 부른다 — 롤백되면
 * 없던 일에 대한 메일이 나가고, **메일은 되돌릴 수 없다.**
 *
 * **실패해도 던지지 않는다** (FR-753). 메일이 죽었다고 댓글 저장이 실패하면 안 된다.
 * 알림함에는 이미 남아 있으므로 사람은 앱에서 볼 수 있다.
 */
@Injectable()
export class MentionMailService {
  private readonly log = new Logger('Mail');

  constructor(
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly audit: AuditService,
  ) {}

  /** 커밋 뒤에 부른다. `await`하지 않아도 되도록 스스로 예외를 삼킨다 */
  async notify(outcome: MentionOutcome, actorName: string, pageTitle: string): Promise<void> {
    if (!this.env.WF_MAIL_ENABLED || outcome.recipients.length === 0) return;
    try {
      // **문서 본문을 담지 않는다** (FR-755). 누가 어디서 불렀는지와 링크만.
      // 메일은 앱 밖으로 나가고, 받는 사람이 그 페이지를 볼 권한을 잃어도 메일은 남는다
      const where = outcome.commentId ? '댓글' : '문서';
      const text = [
        `${actorName} 님이 ${where}에서 회원님을 불렀습니다.`,
        '',
        `문서: ${pageTitle}`,
        `바로 가기: ${this.env.WF_PUBLIC_URL || '(주소 미설정)'}/pages/${outcome.pageId}`,
        '',
        '내용은 위키에서 확인해 주세요.',
      ].join('\n');

      const ok = await this.sender.send({
        to: outcome.recipients.map((r) => r.email),
        subject: `[위키] ${actorName} 님이 회원님을 불렀습니다`,
        text,
      });

      // **결과를 감사로그에 남긴다** (FR-756). "메일이 안 왔다"는 신고에 답할 수 있어야 한다.
      // 주소는 담지 않는다 — 감사로그는 오래 남고 개인정보다 (7절)
      await this.audit.record({
        action: ok ? 'mail.send' : 'mail.fail',
        targetType: 'page',
        targetId: outcome.pageId,
        detail: { recipients: outcome.recipients.length, kind: 'mention' },
      });
    } catch (e) {
      // 여기까지 오면 감사 기록마저 실패한 것이다. 로그만 남기고 삼킨다
      this.log.warn(`멘션 메일 처리 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

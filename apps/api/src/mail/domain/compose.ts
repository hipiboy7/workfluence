import { markdownText } from '@workfluence/shared';
import { oneLine } from './request';

/**
 * 메일 한 통의 제목·평문·마크다운 (A등급, P18_설계서_Mail FR-1901). 보내는 쪽(`HttpMailSender`)이 설정(`WF_MAIL_FORMAT`)을 보고 둘 가운데 하나를 싣는다 —
 * 부르는 쪽은 형식을 모른다.
 *
 * - **문서 본문을 싣지 않는다** (P6 FR-755). 누가·어디서·문서 제목·링크만
 * - 평문은 Phase 6의 글 그대로다. 마크다운은 이름·제목을 굵게, 링크를 링크로 — 이름·제목에 든 마크다운 글자는 이스케이프한다(`markdownText`)
 * - 제목(`subject`)은 둘 다 평문이다 — 메일 제목은 마크다운으로 그려지지 않는다
 */
export type MailContent = { subject: string; text: string; markdown: string };

/**
 * 마크다운 안에 넣을 이름·제목 — `<`·`>`·`&`는 **엔터티로** 바꾸고(`\\<`를 이스케이프로 읽지 않는 렌더러가 있다 — 제목의 `<a href=…>`가 숨은 링크가
 * 된다, P18 병합 전 보안 검토 1), 나머지 서식 기호는 문서 복사와 같은 규칙(`markdownText`)으로 이스케이프한다. 한 줄로 만든 뒤에 한다
 */
const mdText = (s: string): string => markdownText(s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

/** 마크다운 링크의 주소 — 괄호·빈칸은 퍼센트로(링크가 중간에서 끊기지 않게) */
const linkTarget = (url: string): string =>
  url.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c))); // encodeURIComponent는 괄호를 두고 간다

export function mentionMail(input: { callerName: string | null; where: '댓글' | '문서'; pageTitle: string; pageUrl: string | null }): MailContent {
  // **이름·제목은 한 줄이다** — 줄바꿈(CR 하나·유니코드 줄 구분자)이 새 줄을 만들면 마크다운에서 줄 머리 표기가 되고, 제목은 메일 머리말로 간다
  // (P18 병합 전 보안 검토 3, P7 C.4.1)
  const name = input.callerName === null ? null : oneLine(input.callerName);
  const pageTitle = oneLine(input.pageTitle);
  const { where, pageUrl } = input;
  const closing = '내용은 위키에서 확인해 주세요.';
  const text = [
    name ? `${name} 님이 ${where}에서 회원님을 불렀습니다.` : `${where}에서 회원님이 불렸습니다.`,
    '',
    `문서: ${pageTitle}`,
    // 주소가 없으면 **링크 줄을 아예 빼고 보낸다.** `(주소 미설정)/pages/…`가 사람 메일함에 가면 안 된다 (P6 자체 점검 21)
    ...(pageUrl ? [`바로 가기: ${pageUrl}`] : []),
    '',
    closing,
  ].join('\n');
  const markdown = [
    name ? `**${mdText(name)}** 님이 ${where}에서 회원님을 불렀습니다.` : `${where}에서 회원님이 불렸습니다.`,
    '',
    `문서: **${mdText(pageTitle)}**`,
    ...(pageUrl ? ['', `[문서 열기](${linkTarget(pageUrl)})`] : []),
    '',
    closing,
  ].join('\n');
  return {
    subject: name ? `[위키] ${name} 님이 회원님을 불렀습니다` : '[위키] 문서에서 회원님이 불렸습니다',
    text,
    markdown,
  };
}

/** 시험 명령이 보내는 한 통 (FR-1905) — 보낸 때(`sentAt`, ISO)를 싣는다: 여러 번 보냈을 때 어느 것이 닿았는지 가린다 */
export function testMail(sentAt: string): MailContent {
  return {
    subject: '[위키] 시험 메일',
    text: ['workfluence 위키의 메일 설정을 확인하는 시험 메일입니다.', '이 메일이 보이면 사내 메일 연결이 된 것입니다.', '', `보낸 때: ${sentAt}`].join('\n'),
    markdown: ['**workfluence 위키**의 메일 설정을 확인하는 시험 메일입니다.', '', '이 메일이 보이면 사내 메일 연결이 된 것입니다.', '', `보낸 때: ${sentAt}`].join('\n'),
  };
}

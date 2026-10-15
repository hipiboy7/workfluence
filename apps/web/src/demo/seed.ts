import { DOCUMENT_SCHEMA_VERSION, POLICY_DEFAULTS, type DocMark, type DocNode } from '@workfluence/shared';
import { DEMO_STATE_VERSION, newId, type DemoPage, type DemoState, type DemoUser } from './store';

/**
 * 스마트폰 시연판(F-015)의 **시연 데이터** — IT운영팀 · IT인프라팀(서버·DB·네트워크·미들웨어·SA·품질) · 보안 세 스페이스(사용자 결정 2026-10-15).
 * **모두 지어낸 것이다** — 사람·조직·주소·수치는 실제가 아니다(`CLAUDE.md` 12.3절). 시각은 "처음으로"를 누른 때를 기준으로 거꾸로 센다
 *
 * 시연 사용자는 **김운영**(member)이다 — IT운영팀 주인, IT인프라팀 편집, 보안은 **읽기만**(권한 장면). 감사로그는 **이관리**(관리자)로 본다.
 */

// ---- 문서 짓기 ----

type Inline = string | DocNode;
const txt = (text: string, marks?: DocMark[]): DocNode => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const b = (text: string) => txt(text, [{ type: 'bold' }]);
const inl = (xs: Inline[]) => xs.filter((x) => x !== '').map((x) => (typeof x === 'string' ? txt(x) : x));
const p = (...xs: Inline[]): DocNode => (xs.length ? { type: 'paragraph', content: inl(xs) } : { type: 'paragraph' });
const h = (level: number, text: string): DocNode => ({ type: 'heading', attrs: { level }, content: [txt(text)] });
const li = (x: Inline | Inline[]): DocNode => ({ type: 'listItem', content: [p(...(Array.isArray(x) ? x : [x]))] });
const ul = (...items: (Inline | Inline[])[]): DocNode => ({ type: 'bulletList', content: items.map(li) });
const ol = (...items: (Inline | Inline[])[]): DocNode => ({ type: 'orderedList', attrs: { start: 1 }, content: items.map(li) });
const quote = (...xs: Inline[]): DocNode => ({ type: 'blockquote', content: [p(...xs)] });
const code = (text: string, language = 'bash'): DocNode => ({ type: 'codeBlock', attrs: { language }, content: [txt(text)] });
const cell = (type: 'tableHeader' | 'tableCell', text: string): DocNode => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(text)] });
const table = (head: string[], ...rows: string[][]): DocNode => ({
  type: 'table',
  content: [{ type: 'tableRow', content: head.map((x) => cell('tableHeader', x)) }, ...rows.map((r) => ({ type: 'tableRow', content: r.map((x) => cell('tableCell', x)) }))],
});
const doc = (...blocks: DocNode[]): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: blocks });

// ---- 사람 ----

const PEOPLE: [key: string, username: string, displayName: string, role: DemoUser['role']][] = [
  ['kim', 'kim.ops', '김운영', 'member'],
  ['admin', 'lee.admin', '이관리', 'admin'],
  ['server', 'park.server', '박서버', 'member'],
  ['db', 'choi.db', '최디비', 'member'],
  ['net', 'jung.net', '정네트', 'member'],
  ['mw', 'yoon.mw', '윤미들', 'member'],
  ['sa', 'kang.sa', '강설계', 'member'],
  ['qa', 'oh.qa', '오품질', 'member'],
  ['sec', 'han.sec', '한보안', 'member'],
];

/** 로그인 화면이 보이는 시연 계정 — 앞의 둘 */
export const DEMO_ACCOUNTS = [
  { username: 'kim.ops', label: '김운영 · 팀원 (시연)' },
  { username: 'lee.admin', label: '이관리 · 관리자 (감사로그)' },
] as const;

export function buildSeed(now: Date): DemoState {
  const at = (days: number, hours = 0, minutes = 0) => new Date(now.getTime() - ((days * 24 + hours) * 60 + minutes) * 60_000).toISOString();
  const U: Record<string, string> = {};
  const users: DemoUser[] = PEOPLE.map(([key, username, displayName, role]) => {
    U[key] = newId();
    return { id: U[key], username, displayName, email: `${username}@example.internal`, role, grants: [], createdAt: at(60) };
  });

  const s: DemoState = {
    version: DEMO_STATE_VERSION,
    sessionUserId: null,
    users,
    spaces: [],
    members: [],
    categories: [],
    pages: [],
    comments: [],
    labels: [],
    pageLabels: [],
    notifications: [],
    templates: [],
    audit: [],
    attachments: [],
    policy: { ...POLICY_DEFAULTS },
  };

  const category = (name: string) => {
    const id = newId();
    s.categories.push({ id, name, createdBy: U.admin, createdAt: at(50) });
    return id;
  };
  const CAT = { ops: category('운영'), infra: category('인프라'), sec: category('보안') };

  const space = (key: string, name: string, description: string, kind: 'team' | 'personal', owner: string, categoryId: string | null, crew: [string, 'editor' | 'viewer'][]) => {
    const id = newId();
    s.spaces.push({ id, key, name, description, kind, status: 'active', suspendedByOwner: false, categoryId, createdBy: U[owner], createdAt: at(45), updatedAt: at(3), deletedAt: null });
    if (kind === 'team') {
      s.members.push({ spaceId: id, userId: U[owner], role: 'owner', createdAt: at(45) });
      for (const [k, role] of crew) s.members.push({ spaceId: id, userId: U[k], role, createdAt: at(44) });
    }
    return id;
  };
  const OPS = space('ITOPS', 'IT운영팀', '장애 대응·배포·당직 등 IT 운영 업무의 기준 문서를 모읍니다.', 'team', 'kim', CAT.ops, [
    ['server', 'editor'],
    ['db', 'editor'],
    ['net', 'editor'],
    ['mw', 'editor'],
    ['qa', 'editor'],
    ['sec', 'viewer'],
  ]);
  const INFRA = space('INFRA', 'IT인프라팀', '서버·DB·네트워크·미들웨어·SA·품질 분야별 표준과 절차입니다.', 'team', 'server', CAT.infra, [
    ['kim', 'editor'],
    ['db', 'editor'],
    ['net', 'editor'],
    ['mw', 'editor'],
    ['sa', 'editor'],
    ['qa', 'editor'],
  ]);
  const SEC = space('SEC', '보안', '정보보호 정책과 점검 절차입니다. 보안 담당만 고치고, 다른 팀은 읽기만 합니다.', 'team', 'sec', CAT.sec, [
    ['kim', 'viewer'],
    ['server', 'viewer'],
    ['sa', 'viewer'],
  ]);
  const MINE = space('KIMOPS', '김운영의 메모', '나만 보는 공간입니다.', 'personal', 'kim', null, []);

  // 페이지 — 버전은 [작성자, 며칠 전, 제목, 본문]
  type V = [who: string, daysAgo: number, title: string, content: DocNode];
  const pos: Record<string, number> = {};
  const page = (spaceId: string, parentId: string | null, versions: V[], labels: string[] = []): string => {
    const id = newId();
    const k = `${spaceId}/${parentId}`;
    pos[k] = (pos[k] ?? 0) + 1024;
    const vs = versions.map(([who, days, title, content], i) => ({ no: i + 1, title, content, createdBy: U[who], createdAt: at(days, i) }));
    const pg: DemoPage = {
      id,
      spaceId,
      parentId,
      position: pos[k],
      createdBy: vs[0].createdBy,
      createdAt: vs[0].createdAt,
      updatedAt: vs[vs.length - 1].createdAt,
      deletedAt: null,
      deletedBy: null,
      versions: vs,
    };
    s.pages.push(pg);
    for (const name of labels) {
      let l = s.labels.find((x) => x.name === name);
      if (!l) s.labels.push((l = { id: newId(), name }));
      s.pageLabels.push({ pageId: id, labelId: l.id });
    }
    return id;
  };
  const one = (who: string, days: number, title: string, ...blocks: DocNode[]): V[] => [[who, days, title, doc(...blocks)]];

  // ===== IT운영팀 =====
  const opsHome = page(
    OPS,
    null,
    one(
      'kim',
      30,
      '운영 개요',
      h(1, 'IT운영팀 운영 개요'),
      p('IT운영팀은 사내 업무 시스템이 ', b('멈추지 않게'), ' 지키는 일을 합니다. 이 공간의 문서는 모두 팀이 함께 고치고, 고친 내용은 버전으로 남습니다.'),
      h(2, '주요 업무'),
      ul('장애 감시와 1차 대응', '정기 배포와 변경 관리', '야간·휴일 당직', '운영 지표 보고 (주간)'),
      h(2, '연락'),
      p('급한 장애는 문서보다 ', b('당직 전화'), '가 먼저입니다. 당직 순번은 "야간 당직 안내"에 있습니다.'),
    ),
    ['운영'],
  );

  const incidentV1 = doc(
    h(1, '장애 대응 절차'),
    p('업무 시스템에 장애가 나면 아래 순서대로 대응합니다.'),
    ol('장애를 알아챈 사람이 당직에게 알린다', '당직이 영향 범위를 확인한다', '복구한다', '보고서를 쓴다'),
  );
  const incidentV2 = doc(
    h(1, '장애 대응 절차'),
    p('업무 시스템에 장애가 나면 아래 순서대로 대응합니다. 등급은 "장애 등급 기준"을 봅니다.'),
    ol('장애를 알아챈 사람이 당직에게 알린다', '당직이 영향 범위와 장애 등급을 정한다', '복구한다', '보고서를 쓴다'),
    h(2, '연락망'),
    ul('1차: 당직자', '2차: IT운영팀장'),
  );
  const incidentV3 = doc(
    h(1, '장애 대응 절차'),
    p('업무 시스템에 장애가 나면 아래 순서대로 대응합니다. 등급은 "장애 등급 기준"을 봅니다.'),
    ol(
      '장애를 알아챈 사람이 당직에게 알린다',
      '당직이 영향 범위와 장애 등급을 정한다',
      ['1등급이면 ', b('15분 안에'), ' 팀장과 인프라 담당에게 알린다'],
      '복구한다',
      '보고서를 쓴다 (다음 근무일까지)',
    ),
    h(2, '연락망'),
    ul('1차: 당직자', '2차: IT운영팀장', '3차: IT인프라팀 해당 분야 담당'),
  );
  const incidentV4 = doc(
    h(1, '장애 대응 절차'),
    p('업무 시스템에 장애가 나면 아래 순서대로 대응합니다. 등급은 "장애 등급 기준"을 봅니다.'),
    ol(
      '장애를 알아챈 사람이 당직에게 알린다',
      '당직이 영향 범위와 장애 등급을 정한다',
      ['1등급이면 ', b('15분 안에'), ' 팀장과 인프라 담당에게 알린다'],
      '복구한다 — 복구 전에 로그와 화면을 남긴다',
      '보고서를 쓴다 (다음 근무일까지)',
    ),
    h(2, '연락망'),
    table(['단계', '누구', '언제'], ['1차', '당직자', '바로'], ['2차', 'IT운영팀장', '15분 안에'], ['3차', 'IT인프라팀 해당 분야 담당', '30분 안에']),
    h(2, '처음 확인할 것'),
    code('# 앱 서버 상태\nsystemctl status app\n# 최근 오류 로그\njournalctl -u app --since "10 min ago" | grep -i error'),
  );
  const incidentV5 = doc(
    h(1, '장애 대응 절차'),
    p('업무 시스템에 장애가 나면 아래 순서대로 대응합니다. 등급은 "장애 등급 기준"을 봅니다.'),
    quote(b('먼저 알리고, 그다음 고칩니다.'), ' 혼자 고치다 시간을 넘기는 것이 가장 큰 장애입니다.'),
    ol(
      '장애를 알아챈 사람이 당직에게 알린다',
      '당직이 영향 범위와 장애 등급을 정한다',
      ['1등급이면 ', b('15분 안에'), ' 팀장과 인프라 담당에게 알린다'],
      '복구한다 — 복구 전에 로그와 화면을 남긴다',
      '보고서를 쓴다 (다음 근무일까지, "장애 보고서" 템플릿)',
    ),
    h(2, '연락망'),
    table(
      ['단계', '누구', '언제'],
      ['1차', '당직자', '바로'],
      ['2차', 'IT운영팀장', '15분 안에'],
      ['3차', 'IT인프라팀 해당 분야 담당', '30분 안에'],
      ['4차', '정보보호 담당 (보안 사고 의심 시)', '바로'],
    ),
    h(2, '처음 확인할 것'),
    code('# 앱 서버 상태\nsystemctl status app\n# 최근 오류 로그\njournalctl -u app --since "10 min ago" | grep -i error'),
    h(2, '고칠 때'),
    p('이 절차는 분기마다 다시 봅니다. 고칠 것이 있으면 바로 고치고, 고친 내용은 버전으로 남습니다.'),
  );
  const incident = page(
    OPS,
    opsHome,
    [
      ['kim', 14, '장애 대응 절차', incidentV1],
      ['server', 11, '장애 대응 절차', incidentV2],
      ['kim', 8, '장애 대응 절차', incidentV3],
      ['db', 5, '장애 대응 절차', incidentV4],
      ['kim', 2, '장애 대응 절차', incidentV5],
    ],
    ['장애', '절차'],
  );
  page(
    OPS,
    incident,
    one(
      'kim',
      13,
      '장애 등급 기준',
      h(1, '장애 등급 기준'),
      table(
        ['등급', '기준', '예'],
        ['1등급', '전 직원 업무가 멈춤', '그룹웨어 접속 불가, 전산망 단절'],
        ['2등급', '한 부서 이상의 업무가 멈춤', '결재 시스템 오류'],
        ['3등급', '불편하지만 우회할 수 있음', '조회 화면 느림'],
      ),
      p('애매하면 ', b('한 단계 높게'), ' 잡고, 복구 뒤 보고서에서 낮춥니다.'),
    ),
    ['장애'],
  );
  page(
    OPS,
    incident,
    one(
      'qa',
      12,
      '장애 회고 모음',
      h(1, '장애 회고 모음'),
      p('지난 장애에서 배운 것을 한 줄씩 적습니다. 사람을 탓하지 않고 절차를 고칩니다.'),
      ul('9월: 인증서 만료로 접속 오류 → 만료 30일 전 알림을 더함', '8월: 디스크 가득 참 → 로그 순환 설정 점검을 월간 점검에 넣음'),
    ),
    ['장애', '회고'],
  );
  page(
    OPS,
    opsHome,
    [
      [
        'kim',
        20,
        '배포 체크리스트',
        doc(h(1, '배포 체크리스트'), ul('변경 요청서 승인 확인', '백업 확인', '배포', '동작 확인')),
      ],
      [
        'qa',
        9,
        '배포 체크리스트',
        doc(
          h(1, '배포 체크리스트'),
          p('정기 배포는 ', b('목요일 19시'), '에 합니다. 긴급 배포는 팀장 승인 뒤 언제든 합니다.'),
          h(2, '배포 전'),
          ul('변경 요청서 승인 확인', 'DB 백업 완료 확인', '되돌리는 방법(롤백) 적어 두기', '품질 담당의 시험 결과 확인'),
          h(2, '배포 후'),
          ul('로그인·조회·저장 한 번씩', '오류 로그 10분 지켜보기', '배포 결과를 운영회의에 공유'),
        ),
      ],
    ],
    ['배포', '체크리스트'],
  );
  page(
    OPS,
    opsHome,
    one(
      'kim',
      18,
      '야간 당직 안내',
      h(1, '야간 당직 안내'),
      p('당직은 주 단위로 돌아갑니다. 장애 연락을 받으면 "장애 대응 절차"를 따릅니다.'),
      table(['주', '당직', '대신'], ['10월 2주', '김운영', '박서버'], ['10월 3주', '최디비', '정네트'], ['10월 4주', '윤미들', '오품질']),
    ),
    ['당직'],
  );
  const minutes = page(
    OPS,
    null,
    one('kim', 25, '회의록', h(1, '회의록'), p('주간 운영회의 기록입니다. 새 회의록은 ', b('회의록 템플릿'), '으로 만듭니다.')),
    ['회의록'],
  );
  page(
    OPS,
    minutes,
    one(
      'kim',
      8,
      '2026-10-07 주간 운영회의',
      h(1, '2026-10-07 주간 운영회의'),
      p(b('참석: '), '김운영, 박서버, 최디비, 오품질'),
      h(2, '논의'),
      ul('지난주 장애 0건, 배포 2건 정상', '인증서 갱신 일정 확인 (미들웨어)', '야간 당직 순번 조정'),
      h(2, '할 일'),
      ul('윤미들: 인증서 갱신 절차 문서 갱신', '최디비: 백업 복구 연습 결과 공유'),
    ),
    ['회의록'],
  );
  const lastMeeting = page(
    OPS,
    minutes,
    one(
      'qa',
      1,
      '2026-10-14 주간 운영회의',
      h(1, '2026-10-14 주간 운영회의'),
      p(b('참석: '), '김운영, 박서버, 최디비, 오품질, 정네트'),
      h(2, '논의'),
      ul('배포 체크리스트에 롤백 방법 적기를 넣음', '장애 대응 절차의 연락망에 보안 담당을 더하자는 의견', '다음 배포: 10월 17일(목) 19시'),
      h(2, '할 일'),
      ul('@kim.ops 장애 대응 절차 연락망 고치기', '정네트: 방화벽 신청 절차 정리'),
    ),
    ['회의록', '배포'],
  );
  page(
    OPS,
    null,
    one(
      'kim',
      28,
      '신규 입사자 안내',
      h(1, '신규 입사자 안내'),
      p('IT운영팀에 오신 것을 환영합니다. 첫 주에는 아래를 읽고 당직 선배와 한 번 같이 근무합니다.'),
      ol('운영 개요', '장애 대응 절차', '배포 체크리스트', '보안 공간의 "계정·비밀번호 정책"'),
    ),
    ['신규입사'],
  );

  // ===== IT인프라팀 =====
  const area = (name: string, who: string, intro: string) => page(INFRA, null, one(who, 40, name, h(1, name), p(intro)), ['인프라']);
  const srv = area('서버', 'server', '사내 서버의 표준 구성과 점검 방법입니다.');
  page(
    INFRA,
    srv,
    one(
      'server',
      21,
      '서버 표준 구성',
      h(1, '서버 표준 구성'),
      table(['항목', '표준'], ['운영체제', 'RHEL 9 (사내 표준 이미지)'], ['디스크', 'OS 디스크와 데이터 디스크를 나눈다'], ['시각', '사내 NTP 서버와 맞춘다'], ['접속', '관리망에서만 SSH']),
    ),
    ['표준'],
  );
  page(
    INFRA,
    srv,
    one(
      'server',
      10,
      '월간 서버 점검',
      h(1, '월간 서버 점검'),
      ul('디스크 여유 20% 이상', '로그 순환 설정 확인', '보안 패치 적용 여부', '재부팅 뒤 서비스 자동 기동 확인'),
      p('점검 결과는 운영회의에 공유합니다. 문제가 있으면 ', b('장애 등급 기준'), '으로 판단합니다.'),
    ),
    ['점검', '체크리스트'],
  );
  const dbArea = area('DB', 'db', '데이터베이스의 백업·복구와 계정 기준입니다.');
  page(
    INFRA,
    dbArea,
    one(
      'db',
      16,
      'DB 백업·복구 절차',
      h(1, 'DB 백업·복구 절차'),
      p('매일 새벽 2시에 전체 백업을 받고, ', b('분기마다 복구 연습'), '을 합니다.'),
      code('# 백업 (예시)\npg_dump -Fc -f /backup/app_$(date +%F).dump appdb\n# 복구 연습은 별도 서버에서\npg_restore -d appdb_restore /backup/app_2026-10-01.dump', 'bash'),
      p('복구 연습에서 걸린 시간을 적어 둡니다. 지난 연습: 12분.'),
    ),
    ['절차', '백업'],
  );
  page(
    INFRA,
    dbArea,
    one(
      'db',
      30,
      'DB 계정 관리 기준',
      h(1, 'DB 계정 관리 기준'),
      ul('앱 계정은 표를 만들거나 지우지 못한다', '감사 기록 표는 쌓기만 한다 (고치기·지우기 불가)', '사람 계정은 이름으로 만들고 퇴사 시 바로 막는다'),
    ),
    ['보안', '표준'],
  );
  const netArea = area('네트워크', 'net', '폐쇄망 구성과 방화벽 신청 절차입니다.');
  page(
    INFRA,
    netArea,
    one(
      'net',
      26,
      '망 구성 개요',
      h(1, '망 구성 개요'),
      p('업무망은 인터넷과 끊긴 ', b('폐쇄망'), '입니다. 밖의 파일은 반입 절차를 거쳐서만 들어옵니다.'),
      table(['망', '용도', '인터넷'], ['업무망', '업무 시스템', '안 됨'], ['관리망', '서버 접속·점검', '안 됨'], ['인터넷망', '메일·검색', '됨 (분리 PC)']),
    ),
    ['표준'],
  );
  page(
    INFRA,
    netArea,
    one(
      'net',
      6,
      '방화벽 정책 신청 절차',
      h(1, '방화벽 정책 신청 절차'),
      ol('신청서에 출발지·목적지·포트·기간을 적는다', '보안 담당 검토', '네트워크 담당 적용', '신청자가 접속 확인'),
      p('기간이 지난 정책은 ', b('매월 말'), ' 정리합니다.'),
    ),
    ['절차'],
  );
  const mwArea = area('미들웨어', 'mw', 'WAS·웹 서버·인증서 관리입니다.');
  page(
    INFRA,
    mwArea,
    one(
      'mw',
      15,
      'WAS 재기동 절차',
      h(1, 'WAS 재기동 절차'),
      p('장애 복구로 WAS를 다시 띄울 때는 한 대씩 합니다.'),
      ol('부하분산에서 한 대를 뺀다', '재기동한다', '상태 확인 주소가 200인지 본다', '부하분산에 다시 넣는다'),
    ),
    ['장애', '절차'],
  );
  page(
    INFRA,
    mwArea,
    one(
      'mw',
      4,
      '인증서 갱신 절차',
      h(1, '인증서 갱신 절차'),
      p('사내 인증기관 인증서는 1년마다 바꿉니다. ', b('만료 30일 전'), '에 알림이 옵니다.'),
      ul('새 인증서 발급 요청', '스테이징에서 먼저 바꿔 확인', '운영 반영은 정기 배포 시간에'),
    ),
    ['절차'],
  );
  const saArea = area('SA', 'sa', '시스템 아키텍처 원칙과 용량 계획입니다.');
  page(
    INFRA,
    saArea,
    one(
      'sa',
      35,
      '시스템 아키텍처 원칙',
      h(1, '시스템 아키텍처 원칙'),
      ol('외부 인터넷 자원에 기대지 않는다', '설치는 반입 묶음 하나로 끝난다', '모든 변경은 기록이 남는다', '장애 때 누구나 따라 할 수 있는 문서가 있다'),
    ),
    ['표준'],
  );
  page(
    INFRA,
    saArea,
    one(
      'sa',
      12,
      '용량 계획 (2027)',
      h(1, '용량 계획 (2027)'),
      table(['항목', '지금', '1년 뒤 예상'], ['사용자', '300명', '350명'], ['문서', '2만 건', '3만 건'], ['첨부', '120GB', '200GB']),
    ),
    ['계획'],
  );
  const qaArea = area('품질', 'qa', '시험 기준과 배포 승인 기준입니다.');
  page(
    INFRA,
    qaArea,
    one(
      'qa',
      9,
      '배포 승인 기준',
      h(1, '배포 승인 기준'),
      ul('자동 시험 전부 통과', '주요 화면 수동 확인 (로그인·조회·저장)', '되돌리는 방법이 문서에 있음', '보안 점검 지적 0건'),
      p('하나라도 빠지면 배포하지 않습니다.'),
    ),
    ['배포', '체크리스트'],
  );
  page(
    INFRA,
    qaArea,
    one(
      'qa',
      22,
      '시험 기준',
      h(1, '시험 기준'),
      p('핵심 규칙(권한·문서 검증)은 시험을 먼저 쓰고, 커버리지 ', b('90% 이상'), '을 지킵니다.'),
    ),
    ['표준'],
  );

  // ===== 보안 =====
  const secHome = page(
    SEC,
    null,
    one(
      'sec',
      40,
      '보안 정책 개요',
      h(1, '보안 정책 개요'),
      p('정보보호 담당이 관리합니다. 다른 팀은 읽기만 합니다 — 고칠 것이 있으면 댓글로 남겨 주세요.'),
      ul('계정·비밀번호 정책', '감사로그 보존 기준', '반입 파일 검사 절차', '취약점 점검 결과 처리'),
    ),
    ['보안'],
  );
  page(
    SEC,
    secHome,
    one(
      'sec',
      33,
      '계정·비밀번호 정책',
      h(1, '계정·비밀번호 정책'),
      table(['항목', '기준'], ['길이', '8자 이상, 문자 종류 2가지 이상'], ['잠금', '5번 틀리면 15분 잠금'], ['세션', '30분 쓰지 않으면 끊김, 최대 12시간'], ['퇴사·휴직', '관리자가 바로 정지']),
    ),
    ['보안', '표준'],
  );
  page(
    SEC,
    secHome,
    one(
      'sec',
      27,
      '감사로그 보존 기준',
      h(1, '감사로그 보존 기준'),
      p('누가·언제·무엇을 했는지는 ', b('지우거나 고칠 수 없게'), ' 남깁니다. 보존 기간이 지난 것만 정해진 절차로 정리합니다.'),
    ),
    ['보안'],
  );
  page(
    SEC,
    null,
    one(
      'sec',
      7,
      '반입 파일 검사 절차',
      h(1, '반입 파일 검사 절차'),
      ol('반입 신청서와 파일 목록을 대조한다', '지문(SHA-256)을 확인한다', '백신 검사', '반입 기록을 남긴다'),
    ),
    ['보안', '절차'],
  );
  page(
    SEC,
    null,
    one(
      'sec',
      3,
      '취약점 점검 결과 처리',
      h(1, '취약점 점검 결과 처리'),
      p('점검에서 나온 취약점은 등급별로 기한 안에 고칩니다.'),
      table(['등급', '기한'], ['긴급', '7일'], ['높음', '30일'], ['보통', '다음 정기 배포']),
    ),
    ['보안', '점검'],
  );

  // ===== 개인 공간 =====
  page(
    MINE,
    null,
    one('kim', 2, '이번 주 할 일', h(1, '이번 주 할 일'), ul('장애 대응 절차 연락망 고치기', '당직 순번 공지', '배포 체크리스트 검토')),
  );

  // ---- 댓글·알림 ----
  const comment = (pageId: string, who: string, hoursAgo: number, ...xs: Inline[]) => {
    const id = newId();
    s.comments.push({ id, pageId, parentId: null, body: doc(p(...xs)), createdBy: U[who], createdAt: at(0, hoursAgo), updatedAt: at(0, hoursAgo) });
    return id;
  };
  comment(incident, 'server', 30, '연락망 표 좋네요. 서버 쪽은 제가 3차로 받겠습니다.');
  const cm = comment(incident, 'db', 3, '@kim.ops 4차에 정보보호 담당 연락처도 적어 주시면 좋겠습니다. 지난달 침해 의심 건 때 찾느라 늦었어요.');
  s.notifications.push(
    { id: newId(), userId: U.kim, kind: 'mention', pageId: incident, commentId: cm, actorId: U.db, readAt: null, createdAt: at(0, 3) },
    { id: newId(), userId: U.kim, kind: 'mention', pageId: lastMeeting, commentId: null, actorId: U.qa, readAt: null, createdAt: at(1) },
  );

  // ---- 템플릿 ----
  s.templates.push(
    {
      id: newId(),
      name: '회의록',
      description: '주간 운영회의 기록',
      content: doc(h(1, 'YYYY-MM-DD 회의'), p(b('참석: ')), h(2, '논의'), ul(''), h(2, '할 일'), ul('')),
      updatedAt: at(20),
    },
    {
      id: newId(),
      name: '장애 보고서',
      description: '장애 뒤 다음 근무일까지',
      content: doc(
        h(1, '장애 보고서'),
        table(['항목', '내용'], ['발생 시각', ''], ['복구 시각', ''], ['등급', ''], ['영향 범위', '']),
        h(2, '원인'),
        p(),
        h(2, '재발 방지'),
        ul(''),
      ),
      updatedAt: at(20),
    },
    {
      id: newId(),
      name: '작업 계획서',
      description: '변경 작업 전에',
      content: doc(h(1, '작업 계획서'), p(b('작업 시간: ')), h(2, '순서'), ol(''), h(2, '되돌리는 방법'), p()),
      updatedAt: at(20),
    },
  );
  // 빈 목록 항목의 빈 문단은 허용 목록이 받지만 `li('')`는 글 없는 문단이다 — 편집기가 만드는 것과 같다
  s.templates.forEach((t) => fixEmpty(t.content));

  // ---- 첨부 (목록만) ----
  s.attachments.push({ id: newId(), pageId: incident, filename: '장애연락망_2026.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 18_432, uploadedBy: U.kim, createdAt: at(5) });

  // ---- 지난 감사 기록 몇 줄 (최근이 뒤) ----
  const past: [string, string | null, string | null, string | null, Record<string, unknown> | null, number][] = [
    ['auth.login.success', 'admin', 'user', U.admin, { method: 'local' }, 50],
    ['space.create', 'kim', 'space', OPS, { name: 'IT운영팀', kind: 'team' }, 45],
    ['space.create', 'server', 'space', INFRA, { name: 'IT인프라팀', kind: 'team' }, 45],
    ['space.create', 'sec', 'space', SEC, { name: '보안', kind: 'team' }, 45],
    ['space.member.add', 'sec', 'space', SEC, { userId: U.kim, role: 'viewer' }, 44],
    ['page.update', 'db', 'page', incident, { versionNo: 4 }, 5],
    ['auth.login.failure', null, 'user', null, { username: 'kim.ops' }, 2],
    ['page.update', 'kim', 'page', incident, { versionNo: 5 }, 2],
    ['comment.create', 'db', 'comment', cm, { pageId: incident }, 0],
  ];
  for (const [action, who, tt, tid, detail, days] of past) {
    s.audit.push({ id: newId(), action, actorId: who ? U[who] : null, targetType: tt, targetId: tid, detail, createdAt: at(days, days === 0 ? 3 : 0) });
  }
  s.audit.sort((a, b2) => (a.createdAt < b2.createdAt ? -1 : 1));
  return s;
}

/** 글 없는 텍스트 노드는 허용 목록이 받지 않는다 — 빈 문단으로 바꾼다 */
function fixEmpty(n: DocNode): void {
  if (n.content) {
    n.content = n.content.filter((x) => !(x.type === 'text' && !x.text));
    for (const x of n.content) fixEmpty(x);
    if (n.type === 'paragraph' && n.content.length === 0) delete n.content;
  }
}

import type { DelegableAction, DocNode, NotificationKind, Policy, Role, SpaceKind, SpaceMemberRole, SpaceStatus } from '@workfluence/shared';

/**
 * 스마트폰 시연판(F-015)의 **폰 안 저장소** — 서버의 표를 한 JSON으로 들고 `localStorage`에 둔다. 껐다 켜도 남고, **시연 데이터 처음으로**가
 * 시드로 되돌린다. 제품 빌드에는 실리지 않는다(`src/api.ts`가 `--mode demo`일 때만 부른다)
 */

export type DemoUser = { id: string; username: string; displayName: string; email: string; role: Role; grants: DelegableAction[]; createdAt: string };
export type DemoSpace = {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: SpaceKind;
  status: SpaceStatus;
  suspendedByOwner: boolean;
  categoryId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type DemoMember = { spaceId: string; userId: string; role: SpaceMemberRole; createdAt: string };
export type DemoCategory = { id: string; name: string; createdBy: string; createdAt: string };
export type DemoVersion = { no: number; title: string; content: DocNode; createdBy: string; createdAt: string };
export type DemoPage = {
  id: string;
  spaceId: string;
  parentId: string | null;
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  versions: DemoVersion[];
};
export type DemoComment = { id: string; pageId: string; parentId: string | null; body: DocNode; createdBy: string; createdAt: string; updatedAt: string };
export type DemoLabel = { id: string; name: string };
export type DemoPageLabel = { pageId: string; labelId: string };
export type DemoNotification = {
  id: string;
  userId: string;
  kind: NotificationKind;
  pageId: string | null;
  commentId: string | null;
  actorId: string | null;
  readAt: string | null;
  createdAt: string;
};
export type DemoTemplate = { id: string; name: string; description: string | null; content: DocNode; updatedAt: string };
export type DemoAudit = {
  id: string;
  action: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};
export type DemoAttachment = { id: string; pageId: string; filename: string; mime: string; size: number; uploadedBy: string; createdAt: string };

export type DemoState = {
  /** 모양이 바뀌면 올린다 — 옛 모양이 남은 폰은 시드로 다시 시작한다 */
  version: number;
  sessionUserId: string | null;
  users: DemoUser[];
  spaces: DemoSpace[];
  members: DemoMember[];
  categories: DemoCategory[];
  pages: DemoPage[];
  comments: DemoComment[];
  labels: DemoLabel[];
  pageLabels: DemoPageLabel[];
  notifications: DemoNotification[];
  templates: DemoTemplate[];
  audit: DemoAudit[];
  attachments: DemoAttachment[];
  policy: Policy;
};

export const DEMO_STATE_VERSION = 1;
const KEY = 'wf-demo:state';

/** 시연 계정의 비밀번호 — 로그인 화면에 적혀 있다(지어낸 시연 데이터다, `CLAUDE.md` 12.3절) */
export const DEMO_PASSWORD = 'demo1234';

export function loadState(seed: () => DemoState): DemoState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as DemoState;
      if (s && s.version === DEMO_STATE_VERSION) return s;
    }
  } catch {
    // 깨졌으면 처음부터
  }
  const s = seed();
  saveState(s);
  return s;
}

export function saveState(s: DemoState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 저장소가 가득 차도 화면은 돈다 — 껐다 켜면 그만큼 잃는다
  }
}

export function clearState(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // 지울 수 없으면 다음 시드가 덮는다
  }
}

/** uuid v4 — WebView(https://localhost)는 안전한 출처라 `crypto.randomUUID`가 있다. 없으면 같은 모양으로 만든다 */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

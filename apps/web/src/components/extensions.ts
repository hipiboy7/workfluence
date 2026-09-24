import type { AnyExtension } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { ALLOWED_LINK_HREF } from '@workfluence/shared';

/**
 * **링크가 되어도 되는 주소인가** — 서버 검증과 같은 식이다(7절: http(s)·내부 경로·앵커만, P9_설계서_Gate FR-1008).
 *
 * 편집기(TipTap Link)의 기본은 `mailto:`·`tel:` 등도 링크로 만들고, 이메일 주소를 치면 `mailto:` 링크가 자동으로 생겼다.
 * 서버는 그것을 받지 않아 **그 문서의 저장이 멈췄다**(Phase 6부터, P9 B.2). 편집기가 서버와 다른 규칙을 들면 같은 일이
 * 또 생긴다 — 그래서 식을 공유 패키지에서 가져온다. 스킴 없이 친 주소(`www.example.internal`)도 링크가 되지 않는다:
 * 자동 링크가 검사하는 값은 친 글자 그대로라, 그것을 받아 주면 붙여 넣은 HTML의 상대 주소도 함께 받게 된다.
 */
export function linkAllowed(url: string): boolean {
  return ALLOWED_LINK_HREF.test(url.trim());
}

/**
 * **두 편집기가 쓰는 확장 목록** (P9 D.7, FR-1007). 보기·편집용(`Editor.tsx`)과 실시간(`CollabEditor.tsx`)이 이것 하나를 쓴다 —
 * 따로 들면 한쪽만 바뀐다. 이 목록에서 뽑은 스키마가 서버 허용 목록과 같은지를 `extensions.spec.ts`가 본다.
 *
 * `collab`이면 실행 취소를 끈다 — Yjs가 자기 실행 취소를 들고 있어 둘을 같이 두면 내 취소가 남의 편집까지 되돌린다.
 */
export function editorExtensions(opts: { collab?: boolean } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      ...(opts.collab ? { undoRedo: false as const } : {}),
      link: {
        // 붙여 넣은 HTML의 `href`, 링크 명령, 자동 링크의 후보가 모두 이것을 지난다. TipTap의 기본 검사(XSS 방어)도 그대로 둔다
        isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && linkAllowed(url),
        // 붙여 넣기는 위의 검사를 거치지 않고 이것만 본다 — 이메일을 붙여 넣으면 `mailto:`가 되던 길
        shouldAutoLink: linkAllowed,
      },
    }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ];
}

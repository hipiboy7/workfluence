/**
 * 아이콘 (P17 설계서 J.5.12) — 이 파일 안의 SVG다. 외부 자원·아이콘 묶음을 쓰지 않는다(`CLAUDE.md` 7절, J.9-1).
 * 늘 글이나 이름(`aria-label`)과 함께 쓴다 — 그림만으로 뜻을 전하지 않는다. `currentColor`라 글자색을 따른다
 */
import type { ReactNode } from 'react';

const Svg = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

/** 알림 — 종 모양 */
export const BellIcon = () => (
  <Svg>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Svg>
);

/** 왼쪽 칸 접기·펴기 — 세 줄 */
export const MenuIcon = () => (
  <Svg>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);

/** 트리 펼침 — 펼쳤으면 아래, 접었으면 오른쪽 */
export const ChevronIcon = ({ open }: { open: boolean }) => (
  <Svg size={16}>{open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}</Svg>
);

export const CopyIcon = () => (
  <Svg size={16}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
);

export const PlusIcon = () => (
  <Svg size={16}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const PaperclipIcon = () => (
  <Svg size={16}>
    <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.3l7.9-7.9" />
  </Svg>
);

export const ExternalIcon = () => (
  <Svg size={14}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
);

export const LockIcon = () => (
  <Svg size={16}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);

export const UserIcon = () => (
  <Svg size={16}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Svg>
);

// ---- 서식 단추 줄 (P19 D.1) — 글자 서식은 그 모양의 글자(`FormatGlyph`), 나머지는 선 그림 ----

/** 글자 서식의 모양 — 굵은 B, 기운 I, 밑줄 U, 줄 그은 S. 그림 대신 그 서식을 입힌 글자 하나다 */
export const FormatGlyph = ({ kind }: { kind: 'bold' | 'italic' | 'underline' | 'strike' }) => (
  <span className={`fmt-glyph fmt-${kind}`} aria-hidden="true">
    {{ bold: 'B', italic: 'I', underline: 'U', strike: 'S' }[kind]}
  </span>
);

export const CodeIcon = () => (
  <Svg>
    <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
  </Svg>
);

export const BulletListIcon = () => (
  <Svg>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <circle cx="5" cy="6" r="1" />
    <circle cx="5" cy="12" r="1" />
    <circle cx="5" cy="18" r="1" />
  </Svg>
);

export const OrderedListIcon = () => (
  <Svg>
    <path d="M10 6h10M10 12h10M10 18h10M4 4.5l1.5-1V9M3.5 13.5a1.5 1.5 0 1 1 2.6 1L3.5 17h3" />
  </Svg>
);

export const QuoteIcon = () => (
  <Svg>
    <path d="M5 6v12M9 8h11M9 12h11M9 16h7" />
  </Svg>
);

export const CodeBlockIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M10 9l-3 3 3 3M14 9l3 3-3 3" />
  </Svg>
);

export const RuleIcon = () => (
  <Svg>
    <path d="M3 12h18" />
  </Svg>
);

export const LinkIcon = () => (
  <Svg>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);

export const TableIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="1" />
    <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
  </Svg>
);

export const UndoIcon = () => (
  <Svg>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </Svg>
);

export const RedoIcon = () => (
  <Svg>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </Svg>
);

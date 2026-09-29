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

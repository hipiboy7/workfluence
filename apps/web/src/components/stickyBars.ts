import { useCallback, useEffect, useRef } from 'react';

/**
 * 편집 화면의 **창 위에 붙는 막대들** — 위 막대 · 편집 줄 · 서식 단추 줄 (P17 J.12-16 · P19 A.1-17).
 *
 * 막대는 창이 좁거나(편집 줄 — 같이 보는 사람이 많다) 표 안이면(서식 단추 줄 — 표 무리가 붙는다) 두 줄로 접혀 커진다. 한 줄씩의 고정값으로 두면 커서가
 * 둘째 줄 뒤에 숨고, 아래 막대가 위 막대의 둘째 줄을 덮는다(병합 전 자체 점검 2 — 기본 폭에서 서식 단추 줄이 78px로 접혔다). 그래서 **지금 높이**를 잰다
 */
const BARS: readonly (readonly [selector: string, fallback: number])[] = [
  ['.topbar', 48],
  ['.edit-bar', 48],
  ['.format-bar.full', 44],
];

/** 막대들의 지금 높이의 합(px) — 편집기가 스크롤할 때마다 읽는다(`EDIT_SCROLL_MARGIN`). 아직 그려지지 않았으면(높이 0) 한 줄의 높이로 친다 */
export function stuckBarsHeight(): number {
  return BARS.reduce((sum, [selector, fallback]) => sum + (document.querySelector<HTMLElement>(selector)?.offsetHeight || fallback), 0);
}

/** 막대의 높이를 담는 CSS 변수 — 아래에 붙는 막대의 `top`과 창의 `scroll-padding-top`이 쓴다(`styles.css`) */
export type BarHeightVar = '--edit-bar-h' | '--format-bar-h';

/**
 * 그 막대의 높이를 CSS 변수로 둔다 — 요소가 붙을 때 재기 시작하고(`ResizeObserver`) 떨어지면 변수를 지운다. 요소는 나중에 그려질 수 있어(페이지를 읽은 뒤)
 * 붙는 순간을 받는 콜백 ref로 준다
 */
export function useBarHeightVar(name: BarHeightVar, enabled = true, onResize?: () => void): (el: HTMLElement | null) => void {
  const stop = useRef<(() => void) | null>(null);
  const resized = useRef(onResize);
  resized.current = onResize;
  useEffect(() => () => stop.current?.(), []);
  return useCallback(
    (el: HTMLElement | null) => {
      stop.current?.();
      stop.current = null;
      if (!el || !enabled || typeof ResizeObserver === 'undefined') return;
      const root = document.documentElement;
      const set = () => root.style.setProperty(name, `${el.offsetHeight}px`);
      set();
      const observer = new ResizeObserver(() => {
        set();
        resized.current?.();
      });
      observer.observe(el);
      stop.current = () => {
        observer.disconnect();
        root.style.removeProperty(name);
      };
    },
    [name, enabled],
  );
}

import './demo.css';

/**
 * 스마트폰 시연판(F-015)의 시작 — `main.tsx`가 시연 빌드에서만 화면을 그리기 전에 들인다. 폰 화면 맞춤(`demo.css`)을 싣고, 폰답게 움직인다:
 * - ☰ 서랍 안의 링크를 누르거나 서랍 바깥(어두운 막)을 누르면 닫힌다. 제품의 틀(`AppLayout`)은 고치지 않는다 — ☰ 단추를 대신 누른다
 * - 안드로이드 뒤로 가기: 열린 대화·알림 판·서랍을 먼저 닫고, 그다음 앞 화면, 첫 화면(스페이스·로그인)에서는 앱을 닫는다. Capacitor의 네이티브
 *   다리(`window.Capacitor` — 앱이 넣는다)만 쓰고 JS 꾸러미는 들이지 않는다. 브라우저에서 열면 다리가 없어 아무것도 하지 않는다
 */
function drawerToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-controls="side"][aria-expanded="true"]');
}

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement | null;
  if (!t) return;
  if (t.closest('.side a[href]')) {
    // 링크가 먼저 화면을 바꾸게 하고 닫는다
    setTimeout(() => drawerToggle()?.click(), 0);
    return;
  }
  if (t.classList.contains('app-body') && !t.classList.contains('side-collapsed')) drawerToggle()?.click();
});

type CapBridge = {
  addListener?: (plugin: string, event: string, cb: (data: { canGoBack?: boolean }) => void) => unknown;
};

function onBack(): void {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (dialog) return dialog.close();
  const bell = document.querySelector<HTMLButtonElement>('.notify-button[aria-expanded="true"]');
  if (bell) return bell.click();
  const drawer = drawerToggle();
  if (drawer) return drawer.click();
  const home = ['/', '/login'].includes(window.location.pathname);
  if (!home && window.history.length > 1) return window.history.back();
  (navigator as Navigator & { app?: { exitApp?: () => void } }).app?.exitApp?.();
}

const cap = (window as Window & { Capacitor?: CapBridge }).Capacitor;
cap?.addListener?.('App', 'backButton', onBack);

export {};

import './demo.css';

/**
 * 스마트폰 시연판(F-015)의 시작 — `main.tsx`가 시연 빌드에서만 화면을 그리기 전에 들인다. 폰 화면 맞춤(`demo.css`)을 싣고, ☰ 서랍을
 * 폰답게 닫는다: 서랍 안의 링크를 누르거나 서랍 바깥(어두운 막)을 누르면 닫힌다. 제품의 틀(`AppLayout`)은 고치지 않는다 — ☰ 단추를 대신 누른다
 */
function closeDrawer(): void {
  const toggle = document.querySelector<HTMLButtonElement>('button[aria-controls="side"][aria-expanded="true"]');
  toggle?.click();
}

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement | null;
  if (!t) return;
  if (t.closest('.side a[href]')) {
    // 링크가 먼저 화면을 바꾸게 하고 닫는다
    setTimeout(closeDrawer, 0);
    return;
  }
  if (t.classList.contains('app-body') && !t.classList.contains('side-collapsed')) closeDrawer();
});

export {};

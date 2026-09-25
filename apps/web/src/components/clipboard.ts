/**
 * 클립보드에 쓴다 (P10_설계서_Llm FR-1140, G절 "답 복사").
 *
 * 브라우저의 클립보드 API는 **안전한 출처**(HTTPS·localhost)에서만 있다. 운영은 nginx가 TLS를 끝내므로 있다. 없으면 옛 방식
 * (`execCommand('copy')`)으로 한 번 더 해 보고, 그것도 안 되면 **던진다** — 부른 쪽이 "복사하지 못했다"를 말한다. 조용히
 * 실패하면 사용자는 복사된 줄 알고 붙여 넣다가 빈 칸을 본다.
 */
export async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand('copy')) throw new Error('클립보드에 쓰지 못했다');
  } finally {
    area.remove();
  }
}

/**
 * 업로드 판정 (A등급, P3_설계서_Content 0절, FR-414·415).
 *
 * 순수 함수다 — 파일 내용도 디스크도 보지 않는다. 판정 규칙만 여기 있다.
 */

/** 확장자 → 허용 MIME. **둘 다 맞아야 통과한다** — 이름만 바꾼 실행 파일을 거른다 */
const ALLOWED: Record<string, readonly string[]> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  // **svg는 받지 않는다.** 스크립트가 들어가는 활성 형식이고, 우리가 우리 출처에서 돌려주는 순간
  // `Content-Disposition: attachment` 한 단어에만 기대게 된다. 나중에 미리보기를 붙이는 평범한
  // 변경 하나로 저장형 XSS가 된다. 그림은 png·jpg·gif·webp로 충분하다 (P3 자체 점검 보안 #1)
  txt: ['text/plain'],
  csv: ['text/csv', 'text/plain'],
  md: ['text/markdown', 'text/plain'],
  zip: ['application/zip', 'application/x-zip-compressed'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  hwp: ['application/x-hwp', 'application/haansofthwp', 'application/octet-stream'],
};

/** MB로 적은 설정값을 바이트로. **두 곳에서 각각 곱하지 않는다** (P3 자체 점검 #20) */
export const mbToBytes = (mb: number): number => mb * 1024 * 1024;

/** 파일명에서 확장자만. 마지막 점 뒤를 본다 */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export type UploadCheck = { ok: true } | { ok: false; reason: 'extension' | 'mime' | 'size' | 'empty'; message: string };

export function checkUpload(args: {
  filename: string;
  mime: string;
  size: number;
  maxBytes: number;
  /** 운영이 켜 둔 확장자. 안 주면 전체 화이트리스트다. **이 목록 밖은 받지 않는다** (FR-521) */
  allowedExtensions?: readonly string[];
}): UploadCheck {
  const { filename, mime, size, maxBytes, allowedExtensions } = args;

  // 확장자는 **마지막 점 뒤**를 본다. `a.pdf.exe`는 exe다
  const ext = extensionOf(filename);
  const allowedMimes = allowedExtensions && !allowedExtensions.includes(ext) ? undefined : ALLOWED[ext];
  if (!allowedMimes) {
    return { ok: false, reason: 'extension', message: `허용하지 않는 확장자다: ${ext || '(없음)'}` };
  }
  if (!allowedMimes.includes(mime.toLowerCase())) {
    return { ok: false, reason: 'mime', message: `확장자(.${ext})와 형식(${mime})이 맞지 않는다` };
  }
  // 빈 파일을 'size'로 묶으면 413(너무 크다)으로 나간다 — 뜻이 반대다 (P3 자체 점검 #14)
  if (size <= 0) return { ok: false, reason: 'empty', message: '빈 파일은 올릴 수 없다' };
  if (size > maxBytes) {
    return { ok: false, reason: 'size', message: `파일이 너무 크다 (상한 ${Math.floor(maxBytes / 1024 / 1024)}MB)` };
  }
  return { ok: true };
}

export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);

/**
 * 저장하고 다시 내보낼 형식. **올린 쪽이 말한 것을 쓰지 않는다.**
 *
 * 다운로드 응답의 `Content-Type`이 되는 값이라, 올린 쪽이 정하게 두면 우리 출처에서
 * 임의의 형식을 선언해 주는 셈이 된다. 확장자는 화이트리스트를 지나왔으므로 그쪽에서 도출한다.
 */
export function canonicalMime(filename: string): string {
  const allowed = ALLOWED[extensionOf(filename)];
  if (!allowed) throw new Error(`화이트리스트를 지나지 않은 파일명이다: ${filename}`);
  return allowed[0];
}

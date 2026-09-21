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
  svg: ['image/svg+xml'],
  txt: ['text/plain'],
  csv: ['text/csv', 'text/plain'],
  md: ['text/markdown', 'text/plain'],
  zip: ['application/zip', 'application/x-zip-compressed'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  hwp: ['application/x-hwp', 'application/haansofthwp', 'application/octet-stream'],
};

export type UploadCheck = { ok: true } | { ok: false; reason: 'extension' | 'mime' | 'size'; message: string };

export function checkUpload(args: { filename: string; mime: string; size: number; maxBytes: number }): UploadCheck {
  const { filename, mime, size, maxBytes } = args;

  // 확장자는 **마지막 점 뒤**를 본다. `a.pdf.exe`는 exe다
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  const allowedMimes = ALLOWED[ext];
  if (!allowedMimes) {
    return { ok: false, reason: 'extension', message: `허용하지 않는 확장자다: ${ext || '(없음)'}` };
  }
  if (!allowedMimes.includes(mime.toLowerCase())) {
    return { ok: false, reason: 'mime', message: `확장자(.${ext})와 형식(${mime})이 맞지 않는다` };
  }
  if (size <= 0) return { ok: false, reason: 'size', message: '빈 파일은 올릴 수 없다' };
  if (size > maxBytes) {
    return { ok: false, reason: 'size', message: `파일이 너무 크다 (상한 ${Math.floor(maxBytes / 1024 / 1024)}MB)` };
  }
  return { ok: true };
}

export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);

/**
 * 내용 서명 판정 (A등급, P3_설계서_Content 3.4절, FR-414b).
 *
 * `checkUpload`는 **이름과 선언한 형식**을 본다. 그런데 그 둘은 전부 올리는 쪽이 정한다 —
 * `.hwp`로 이름 짓고 `application/octet-stream`이라고 말하면 바이트는 무엇이든 될 수 있다.
 * 그래서 여기서 **실제 앞부분 바이트**를 본다. 이름과 내용이 맞아야 통과한다.
 *
 * 순수 함수다. 버퍼 앞부분만 읽고 아무것도 바꾸지 않는다.
 */

export type SignatureCheck = { ok: true } | { ok: false; message: string };

/** 같은 확장자에 여러 형태가 있을 수 있다(hwp는 OLE와 zip 둘 다). 하나라도 맞으면 통과 */
const SIGNATURES: Record<string, readonly (readonly number[])[]> = {
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
  // OOXML은 전부 zip이다. 내부 구조까지 보지는 않는다 — 여기서 막으려는 것은 "전혀 다른 형식"이다
  zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]],
  docx: [[0x50, 0x4b, 0x03, 0x04]],
  xlsx: [[0x50, 0x4b, 0x03, 0x04]],
  pptx: [[0x50, 0x4b, 0x03, 0x04]],
  // 한/글 5.x는 OLE 복합문서, hwpx는 zip이다
  hwp: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], [0x50, 0x4b, 0x03, 0x04]],
};

/** 서명이 없는 형식. 대신 "글자처럼 보이는가"로 본다 */
const TEXT_LIKE = new Set(['txt', 'csv', 'md']);

/** webp는 `RIFF····WEBP`처럼 **떨어진 두 자리**를 봐야 해서 표로 적을 수 없다 */
function isWebp(head: Buffer): boolean {
  return head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
}

const startsWith = (head: Buffer, sig: readonly number[]) => sig.every((b, i) => head[i] === b);

export function checkSignature(ext: string, data: Buffer): SignatureCheck {
  if (data.length === 0) return { ok: false, message: '빈 파일은 올릴 수 없다' };

  const lower = ext.toLowerCase();
  const mismatch = { ok: false as const, message: `내용이 .${lower} 형식이 아니다` };

  if (lower === 'webp') return isWebp(data) ? { ok: true } : mismatch;

  if (TEXT_LIKE.has(lower)) {
    // NUL 바이트는 글 파일에 나오지 않는다. 실행 파일·이미지를 .txt로 바꿔 올리는 것을 거른다
    const head = data.subarray(0, 8192);
    return head.includes(0) ? { ok: false, message: `.${lower}인데 글자가 아닌 내용이 들어 있다` } : { ok: true };
  }

  const sigs = SIGNATURES[lower];
  // 여기 오는 확장자는 `checkUpload`의 화이트리스트를 지나온 것뿐이다. 표에 없으면 우리 실수이므로 **막는다**
  if (!sigs) return { ok: false, message: `.${lower}의 내용 검사 규칙이 없다` };

  return sigs.some((sig) => startsWith(data, sig)) ? { ok: true } : mismatch;
}

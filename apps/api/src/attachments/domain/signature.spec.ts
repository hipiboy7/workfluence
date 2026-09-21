import { describe, expect, it } from 'vitest';
import { checkSignature } from './signature';

/** A등급 (P3_설계서_Content 3.4절). 테스트를 먼저 썼다. */
const buf = (...bytes: number[]) => Buffer.from(bytes);
const pdf = Buffer.from('%PDF-1.7\n...');
const png = buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const jpg = buf(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const zip = Buffer.from('PK\x03\x04rest');
const ole = buf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0);
const exe = Buffer.from('MZ\x90\x00this is a windows executable');

describe('checkSignature — 이름이 아니라 내용을 본다', () => {
  it('맞는 내용은 통과한다', () => {
    expect(checkSignature('pdf', pdf)).toEqual({ ok: true });
    expect(checkSignature('png', png)).toEqual({ ok: true });
    expect(checkSignature('jpg', jpg)).toEqual({ ok: true });
    expect(checkSignature('jpeg', jpg)).toEqual({ ok: true });
    expect(checkSignature('gif', Buffer.from('GIF89a....'))).toEqual({ ok: true });
    expect(checkSignature('zip', zip)).toEqual({ ok: true });
    expect(checkSignature('docx', zip)).toEqual({ ok: true });
    expect(checkSignature('xlsx', zip)).toEqual({ ok: true });
    expect(checkSignature('pptx', zip)).toEqual({ ok: true });
  });

  it('webp는 RIFF....WEBP 두 토막을 다 본다', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), buf(1, 2, 3, 4), Buffer.from('WEBP')]);
    expect(checkSignature('webp', webp)).toEqual({ ok: true });
    const riffOnly = Buffer.concat([Buffer.from('RIFF'), buf(1, 2, 3, 4), Buffer.from('AVI ')]);
    expect(checkSignature('webp', riffOnly)).toMatchObject({ ok: false });
  });

  it('**이름만 바꾼 실행 파일을 거른다** — 이것이 이 함수가 있는 이유다', () => {
    for (const ext of ['pdf', 'png', 'jpg', 'gif', 'webp', 'zip', 'docx', 'xlsx', 'pptx', 'hwp']) {
      expect(checkSignature(ext, exe)).toMatchObject({ ok: false });
    }
  });

  it('hwp는 OLE(한/글 5.x)와 zip(hwpx) 둘 다 받는다', () => {
    expect(checkSignature('hwp', ole)).toEqual({ ok: true });
    expect(checkSignature('hwp', zip)).toEqual({ ok: true });
  });

  it('글 파일은 서명이 없으므로 **NUL 바이트가 없는지**로 본다', () => {
    expect(checkSignature('txt', Buffer.from('평범한 한글 텍스트'))).toEqual({ ok: true });
    expect(checkSignature('csv', Buffer.from('a,b,c\n1,2,3'))).toEqual({ ok: true });
    expect(checkSignature('md', Buffer.from('# 제목'))).toEqual({ ok: true });
    expect(checkSignature('txt', exe)).toMatchObject({ ok: false });
    expect(checkSignature('txt', buf(0x61, 0x00, 0x62))).toMatchObject({ ok: false });
  });

  it('빈 내용은 거부한다', () => {
    expect(checkSignature('pdf', Buffer.alloc(0))).toMatchObject({ ok: false });
    expect(checkSignature('txt', Buffer.alloc(0))).toMatchObject({ ok: false });
  });

  it('모르는 확장자는 거부한다 — 화이트리스트를 지나온 것만 온다', () => {
    expect(checkSignature('exe', exe)).toMatchObject({ ok: false });
  });
});

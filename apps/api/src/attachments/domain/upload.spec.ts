import { describe, expect, it } from 'vitest';
import { canonicalMime, checkUpload } from './upload';

/** A등급 (P3_설계서_Content 0절). 테스트를 먼저 썼다. */
const ok = (over: Partial<Parameters<typeof checkUpload>[0]> = {}) =>
  checkUpload({ filename: 'a.pdf', mime: 'application/pdf', size: 1000, maxBytes: 20 * 1024 * 1024, ...over });

describe('checkUpload — 화이트리스트 (FR-414)', () => {
  it('허용 확장자·MIME은 통과한다', () => {
    expect(ok()).toEqual({ ok: true });
    expect(ok({ filename: 'b.PNG', mime: 'image/png' })).toEqual({ ok: true });
    expect(ok({ filename: 'c.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toEqual({ ok: true });
  });

  it('svg는 받지 않는다 — 스크립트가 들어가는 활성 형식이다 (자체 점검 보안 #1)', () => {
    expect(checkUpload({ filename: 'a.svg', mime: 'image/svg+xml', size: 10, maxBytes: 100 })).toMatchObject({ ok: false, reason: 'extension' });
  });

  it('저장할 형식은 **올린 쪽이 말한 것이 아니라 확장자에서 도출한다**', () => {
    expect(canonicalMime('a.pdf')).toBe('application/pdf');
    expect(canonicalMime('B.PNG')).toBe('image/png');
    // hwp는 octet-stream도 받지만, 우리가 돌려주는 것은 언제나 첫 번째(구체적인) 형식이다
    expect(canonicalMime('a.hwp')).toBe('application/x-hwp');
    expect(() => canonicalMime('a.exe')).toThrow();
  });

  it('허용하지 않는 확장자는 막는다', () => {
    for (const f of ['x.exe', 'x.sh', 'x.js', 'x.html', 'x']) {
      expect(checkUpload({ filename: f, mime: 'application/pdf', size: 10, maxBytes: 100 })).toMatchObject({ ok: false, reason: 'extension' });
    }
  });

  it('확장자와 MIME이 어긋나면 막는다 — 이름만 바꾼 실행 파일을 거른다', () => {
    expect(ok({ filename: 'a.pdf', mime: 'text/html' })).toMatchObject({ ok: false, reason: 'mime' });
    expect(ok({ filename: 'a.png', mime: 'application/pdf' })).toMatchObject({ ok: false, reason: 'mime' });
  });
});

describe('checkUpload — 크기 (FR-415)', () => {
  it('상한 이하면 통과, 넘으면 막는다', () => {
    expect(checkUpload({ filename: 'a.pdf', mime: 'application/pdf', size: 100, maxBytes: 100 })).toEqual({ ok: true });
    expect(checkUpload({ filename: 'a.pdf', mime: 'application/pdf', size: 101, maxBytes: 100 })).toMatchObject({ ok: false, reason: 'size' });
  });

  it("빈 파일은 'empty'다 — 'size'로 묶으면 413(너무 크다)으로 나가 뜻이 반대가 된다", () => {
    expect(checkUpload({ filename: 'a.pdf', mime: 'application/pdf', size: 0, maxBytes: 100 })).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('checkUpload — 파일명 (FR-412)', () => {
  it('경로가 섞인 이름도 **확장자 판정에는 쓰되 경로로 쓰지 않는다**', () => {
    // 저장 경로는 해시라 여기서 막을 필요가 없다. 확장자만 정확히 읽으면 된다
    expect(ok({ filename: '../../etc/passwd.pdf' })).toEqual({ ok: true });
    expect(ok({ filename: '../../etc/passwd' })).toMatchObject({ ok: false, reason: 'extension' });
  });

  it('점이 여러 개면 마지막 것을 본다', () => {
    expect(ok({ filename: 'a.exe.pdf' })).toEqual({ ok: true });
    expect(ok({ filename: 'a.pdf.exe', mime: 'application/pdf' })).toMatchObject({ ok: false, reason: 'extension' });
  });
});

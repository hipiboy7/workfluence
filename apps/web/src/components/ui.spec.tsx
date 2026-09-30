// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Field, FormRow, sectionOf, useReadWide } from './ui';

/**
 * 컴포넌트 시험 — 문서 글 칸의 **넓게 보기** (P17 설계서 J.3.4, 착수 쟁점 5 · 병합 전 검토 8). 보기와 편집·이력이 같은 값을 쓰고 브라우저가 기억한다.
 * 저장소를 쓰지 못해도(막은 정책·할당량) 누른 화면에서는 바뀐다 — 예전에는 알림을 받은 쪽이 저장소를 다시 읽어 옛 값으로 되돌렸다
 */

function Wide({ name }: { name: string }) {
  const [wide, toggle] = useReadWide();
  return (
    <button type="button" aria-label={name} aria-pressed={wide} onClick={toggle}>
      넓게 보기
    </button>
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

describe('useReadWide', () => {
  it('누르면 넓어지고 브라우저가 기억한다 — 같은 화면의 다른 부품도 따라간다', () => {
    render(
      <>
        <Wide name="글 칸" />
        <Wide name="미리보기" />
      </>,
    );
    expect([pressed('글 칸'), pressed('미리보기')]).toEqual(['false', 'false']);
    fireEvent.click(screen.getByRole('button', { name: '글 칸' }));
    expect([pressed('글 칸'), pressed('미리보기')]).toEqual(['true', 'true']);
    expect(window.localStorage.getItem('wf:read-wide')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    expect([pressed('글 칸'), pressed('미리보기')]).toEqual(['false', 'false']);
    expect(window.localStorage.getItem('wf:read-wide')).toBe('0');
  });

  it('기억한 값으로 시작한다', () => {
    window.localStorage.setItem('wf:read-wide', '1');
    render(<Wide name="글 칸" />);
    expect(pressed('글 칸')).toBe('true');
  });

  it('**저장소를 쓰지 못해도 이 화면에서는 바뀐다** — 다른 부품도 같은 값이다', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    render(
      <>
        <Wide name="글 칸" />
        <Wide name="미리보기" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: '글 칸' }));
    expect([pressed('글 칸'), pressed('미리보기')]).toEqual(['true', 'true']);
    fireEvent.click(screen.getByRole('button', { name: '글 칸' }));
    expect([pressed('글 칸'), pressed('미리보기')]).toEqual(['false', 'false']);
  });
});

describe('Field·FormRow — 필수 표시 (J.5.3, FR-1855 · 병합 전 검토 11)', () => {
  it('**"필수"는 label 밖이다** — 칸은 `required`이고 라벨 이름은 이름만이라 정확 일치로 찾는다', () => {
    render(
      <>
        <Field id="f-name" label="이름" required>
          <input id="f-name" />
        </Field>
        <FormRow id="r-title" label="제목" required>
          <input id="r-title" />
        </FormRow>
        <Field id="f-memo" label="메모">
          <input id="f-memo" />
        </Field>
      </>,
    );
    for (const name of ['이름', '제목']) {
      const box = screen.getByLabelText(name) as HTMLInputElement;
      expect(box.required).toBe(true);
      // 보이는 "필수"는 칸 곁에 있고 보조기기는 칸의 required로 읽는다
      const mark = box.closest('.field, .form-row')!.querySelector('.req')!;
      expect(mark.textContent).toBe('필수');
      expect(mark.getAttribute('aria-hidden')).toBe('true');
      expect(mark.closest('label')).toBeNull();
    }
    expect((screen.getByLabelText('메모') as HTMLInputElement).required).toBe(false);
    expect(screen.getByLabelText('메모').closest('.field')!.querySelector('.req')).toBeNull();
  });
});

/** 탭 제목의 구역 (P17 FR-1854) — 로그인 전 화면에는 구역이 없다. 예전에는 새 비밀번호 정하기에 "스페이스"가 붙었다(P19 병합 전 코드 리뷰 추가 10) */
describe('sectionOf', () => {
  it('로그인 전 화면은 구역이 없다 — 비밀번호 찾기·email 확인 요청·새 비밀번호 정하기도', () => {
    for (const p of ['/login', '/signup', '/find-account', '/find-account/root', '/find-account/email', '/reset-password']) expect(sectionOf(p), p).toBe('');
  });

  it('나머지는 메뉴의 구역', () => {
    expect(sectionOf('/admin/users')).toBe('관리');
    expect(sectionOf('/pages/x')).toBe('스페이스');
  });
});

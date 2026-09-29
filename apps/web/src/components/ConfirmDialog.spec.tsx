// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useConfirm, type ConfirmOptions } from './ConfirmDialog';

/** 확인 대화 (P17 설계서 J.5.10, FR-1858) — 부르는 쪽이 받는 답과, 처음 초점·Esc·확정 단추의 모양 */
afterEach(cleanup);

function Harness({ opts, onAnswer }: { opts: ConfirmOptions; onAnswer: (ok: boolean) => void }) {
  const [confirm, dialog] = useConfirm();
  return (
    <>
      <button type="button" onClick={() => void confirm(opts).then(onAnswer)}>
        삭제
      </button>
      {dialog}
    </>
  );
}

const OPTS: ConfirmOptions = { title: '이 첨부를 지울까요?', body: '보고서.pdf — 되살릴 수 없다.', confirmLabel: '지운다' };

async function open(opts = OPTS) {
  const answers: boolean[] = [];
  render(<Harness opts={opts} onAnswer={(ok) => answers.push(ok)} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
  });
  return answers;
}

describe('확인 대화', () => {
  it('제목과 본문을 보이고, 처음 초점은 그만두기다 — Enter를 잘못 눌러도 지워지지 않는다', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: '이 첨부를 지울까요?' });
    expect(dialog.textContent).toContain('보고서.pdf — 되살릴 수 없다.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '그만두기' }));
  });

  it('확정을 누르면 참, 대화가 닫힌다', async () => {
    const answers = await open();
    const confirmButton = screen.getByRole('button', { name: '지운다' });
    // 위험한 확정은 채운 위험 단추다 — 확인 대화 안에서만 쓴다(J.5.2)
    expect(confirmButton.className).toBe('danger solid');
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    expect(answers).toEqual([true]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('그만두기와 Esc(취소 이벤트)는 거짓이다', async () => {
    const answers = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '그만두기' }));
    });
    expect(answers).toEqual([false]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    });
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(answers).toEqual([false, false]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('위험하지 않은 확정은 주 단추다', async () => {
    await open({ ...OPTS, confirmLabel: '넘긴다', danger: false });
    expect(screen.getByRole('button', { name: '넘긴다' }).className).toBe('primary');
  });
});

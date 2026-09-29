import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type ConfirmOptions = {
  /** 대화 상자 제목 — "이 첨부를 지울까요?" */
  title: string;
  /** 대상 이름과 되돌릴 수 있는지 */
  body?: ReactNode;
  /** 확정 단추의 이름 — **부른 단추의 이름을 품지 않게** 짓는다(시험이 둘을 만나지 않게, J.5.10) */
  confirmLabel: string;
  cancelLabel?: string;
  /** 위험한 확정(지우기 등)이면 위험 단추 — 기본 true */
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

/**
 * 확인 대화 (P17 설계서 J.5.10, FR-1858). 브라우저 내장 `<dialog>`와 `showModal()`을 쓴다 — 초점 가두기·Esc·맨 위 층을 브라우저가 맡는다
 * (새 의존성 없음). 처음 초점은 **그만두기**다. 예전의 `window.confirm`은 화면 모양과 맞지 않았고 E2E가 브라우저 창을 따로 받아야 했다.
 *
 * 쓰는 법: `const [confirm, dialog] = useConfirm();` 을 부르고, `dialog`를 화면에 한 번 그린 뒤 `if (!(await confirm({...}))) return;`
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...opts, resolve });
      }),
    [],
  );
  const close = useCallback(
    (ok: boolean) => {
      setPending((p) => {
        p?.resolve(ok);
        return null;
      });
    },
    [],
  );
  const dialog = pending ? <ConfirmDialog {...pending} onClose={close} /> : null;
  return [confirm, dialog];
}

function ConfirmDialog({ title, body, confirmLabel, cancelLabel = '그만두기', danger = true, onClose }: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    cancelRef.current?.focus();
    // Esc로 닫으면 cancel 이벤트가 온다 — 그만두기와 같다
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose(false);
    };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
    };
  }, [onClose]);
  return (
    <dialog ref={ref} className="confirm" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{title}</h2>
      {body && <div className="muted">{body}</div>}
      <div className="form-actions">
        <button type="button" ref={cancelRef} onClick={() => onClose(false)}>
          {cancelLabel}
        </button>
        <button type="button" className={danger ? 'danger solid' : 'primary'} onClick={() => onClose(true)}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

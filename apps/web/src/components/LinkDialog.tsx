import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Field } from './ui';

/**
 * 링크 대화 (P19_설계서_Recovery D.2, FR-2023). 확인 대화(P17 J.5.10)와 같은 틀 — 브라우저 내장 `<dialog>`·`showModal()`(초점 가두기·Esc를 브라우저가
 * 맡는다, 새 의존성 없음). 첫 초점은 주소 칸이다.
 *
 * **넣기**가 까닭을 돌려주면(`onSubmit` — 링크가 되지 않는 주소) 닫지 않고 칸 아래에 보인다. **링크 빼기**는 커서가 링크 위일 때만. **그만두기**·Esc는
 * 아무것도 하지 않는다. 닫힌 뒤 초점을 어디로 보낼지는 부른 쪽(`onClose`)이 정한다 — 본문으로 돌아간다
 */
export function LinkDialog({
  initial,
  canRemove,
  onSubmit,
  onRemove,
  onClose,
}: {
  initial: string;
  canRemove: boolean;
  /** 주소를 받는다 — 안 되면 까닭, 되면 `null`(대화가 닫힌다) */
  onSubmit: (href: string) => string | null;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [href, setHref] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
    // Esc로 닫으면 cancel 이벤트가 온다 — 그만두기와 같다
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = onSubmit(href);
    if (problem) setError(problem);
    else onClose();
  };

  return (
    <dialog ref={ref} className="confirm" aria-labelledby="link-title">
      <form onSubmit={submit} noValidate>
        <h2 id="link-title">링크</h2>
        <Field id="link-href" label="주소" error={error ?? undefined} help="예: https://example.internal/문서 · /pages/… (위키 안 주소)">
          <input
            id="link-href"
            ref={inputRef}
            className="w-full"
            type="url"
            inputMode="url"
            value={href}
            onChange={(e) => {
              setHref(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <div className="form-actions">
          {canRemove && (
            <button
              type="button"
              className="subtle"
              onClick={() => {
                onRemove();
                onClose();
              }}
            >
              링크 빼기
            </button>
          )}
          <button type="button" onClick={onClose}>
            그만두기
          </button>
          <button type="submit" className="primary">
            {canRemove ? '주소 바꾸기' : '링크 넣기'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentView } from '@workfluence/shared';
import { api } from '../api';
import { useConfirm } from './ConfirmDialog';
import { Field, Notice } from './ui';

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))}KB`;

/**
 * 첨부 목록·올리기·내려받기 (P3_설계서_Content 3절).
 *
 * 내려받기는 **평범한 링크**다. `fetch`로 받아 Blob을 만들면 파일명·형식을 화면이 다시
 * 정해야 하는데, 그 판단은 서버 헤더에 이미 있다 (FR-417).
 *
 * 페이지 보기의 한 구획이다(P17 설계서 J.5.6). 목록은 데이터 표(J.5.5 — 파일·크기·올린 사람·조치), 올리기 칸에는 보이는 라벨 "첨부할 파일"이
 * 있다(J.7 — 예전에는 이름만 있고 보이는 라벨이 없었다). **지우기 전에 묻는다**(J.5.10) — 화면에서 되살리는 길이 없다
 */
export function Attachments({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<AttachmentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(() => {
    api<AttachmentView[]>(`/api/pages/${pageId}/attachments`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [pageId]);
  useEffect(load, [load]);

  const upload = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      // content-type을 직접 넣지 않는다 — 브라우저가 multipart 경계를 붙여야 한다
      await api(`/api/pages/${pageId}/attachments`, { method: 'POST', body: form });
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: AttachmentView) => {
    // 확정 단추는 "삭제"를 품지 않는다 — 시험이 부른 단추와 확정 단추를 헷갈리지 않게(J.5.10)
    const ok = await confirm({
      title: '이 첨부를 지울까요?',
      body: (
        <p>
          <strong className="break-any">{a.filename}</strong>을(를) 이 페이지에서 지운다. 화면에서 되살릴 수 없다.
        </p>
      ),
      confirmLabel: '지운다',
    });
    if (!ok) return;
    setError(null);
    try {
      await api(`/api/attachments/${a.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="doc-section" aria-label="첨부">
      <h2>첨부</h2>
      {dialog}
      {error && <Notice kind="error">{error}</Notice>}
      {rows.length === 0 ? (
        <p className="muted">첨부가 없다.</p>
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">파일</th>
                <th scope="col" className="num">
                  크기
                </th>
                <th scope="col">올린 사람</th>
                {canWrite && (
                  <th scope="col">
                    <span className="sr-only">조치</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="break-any">
                    <a href={`/api/attachments/${a.id}`}>{a.filename}</a>
                  </td>
                  <td className="num">{kb(a.size)}</td>
                  <td>{a.uploadedByName}</td>
                  {canWrite && (
                    <td className="actions-cell">
                      <button type="button" className="danger sm" aria-label={`${a.filename} 삭제`} onClick={() => void remove(a)}>
                        삭제
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && (
        <Field id="attach-file" label="첨부할 파일" help={busy ? '올리는 중…' : undefined}>
          <input
            id="attach-file"
            ref={fileRef}
            type="file"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </Field>
      )}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentView } from '@workfluence/shared';
import { api } from '../api';

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))}KB`;

/**
 * 첨부 목록·올리기·내려받기 (P3_설계서_Content 3절).
 *
 * 내려받기는 **평범한 링크**다. `fetch`로 받아 Blob을 만들면 파일명·형식을 화면이 다시
 * 정해야 하는데, 그 판단은 서버 헤더에 이미 있다 (FR-417).
 */
export function Attachments({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<AttachmentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  return (
    <section className="card" aria-label="첨부">
      <h2>첨부</h2>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {canWrite && (
        <p>
          <input
            ref={fileRef}
            type="file"
            aria-label="첨부할 파일"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </p>
      )}
      {rows.length === 0 ? (
        <p className="muted small">첨부가 없다.</p>
      ) : (
        <ul>
          {rows.map((a) => (
            <li key={a.id}>
              <a href={`/api/attachments/${a.id}`}>{a.filename}</a>{' '}
              <span className="muted small">{kb(a.size)} · {a.uploadedByName}</span>
              {canWrite && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() =>
                      void api(`/api/attachments/${a.id}`, { method: 'DELETE' })
                        .then(load)
                        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    }
                  >
                    삭제
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

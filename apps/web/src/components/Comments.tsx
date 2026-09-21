import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { emptyDocument, type CommentView, type DocNode } from '@workfluence/shared';
import { api } from '../api';
import { Editor } from './Editor';

/** 댓글 본문은 페이지와 같은 문서 형식이다 (FR-420). 표시는 같은 편집기를 읽기 전용으로 쓴다 */
function Body({ doc }: { doc: DocNode }) {
  return <Editor value={doc} editable={false} />;
}

/**
 * 댓글 (P3_설계서_Content 5절).
 *
 * 지울 수 있는지는 **서버가 내려 준 `canDelete`를 쓴다.** 화면이 규칙을 다시 구현하면
 * 서버와 어긋나고, 어긋난 쪽이 화면이면 "버튼은 있는데 눌러도 안 되는" 상태가 된다.
 */
export function Comments({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<CommentView[]>([]);
  const [draft, setDraft] = useState<DocNode>(emptyDocument());
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<CommentView[]>(`/api/pages/${pageId}/comments`)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [pageId]);
  useEffect(load, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/pages/${pageId}/comments`, { method: 'POST', json: { parentId: replyTo, body: draft } });
      setDraft(emptyDocument());
      setReplyTo(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = (id: string) =>
    void api(`/api/comments/${id}`, { method: 'DELETE' })
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const roots = rows.filter((c) => !c.parentId);
  const childrenOf = (id: string) => rows.filter((c) => c.parentId === id);

  const item = (c: CommentView, isReply: boolean) => (
    <li key={c.id} style={isReply ? { marginLeft: '1.5rem' } : undefined}>
      <p className="muted small">
        {c.createdByName} · {new Date(c.createdAt).toLocaleString('ko-KR')}
        {c.canDelete && (
          <>
            {' · '}
            <button type="button" className="linklike" onClick={() => remove(c.id)}>삭제</button>
          </>
        )}
        {/* 대댓글은 한 단계까지다 (FR-421) — 답에는 답 버튼을 두지 않는다 */}
        {canWrite && !isReply && (
          <>
            {' · '}
            <button type="button" className="linklike" onClick={() => setReplyTo(c.id)}>답하기</button>
          </>
        )}
      </p>
      <Body doc={c.body} />
    </li>
  );

  return (
    <section className="card" aria-label="댓글">
      <h2>댓글 {rows.length > 0 && <span className="muted small">{rows.length}</span>}</h2>
      {error && <p className="badge fail" role="alert">{error}</p>}
      {rows.length === 0 && <p className="muted small">댓글이 없다.</p>}
      <ul>
        {roots.map((c) => (
          <Fragment key={c.id}>
            {item(c, false)}
            {childrenOf(c.id).map((r) => item(r, true))}
          </Fragment>
        ))}
      </ul>
      {canWrite && (
        <form onSubmit={submit}>
          <label>{replyTo ? '답 쓰기' : '댓글 쓰기'}</label>
          {replyTo && (
            <p className="muted small">
              답하는 중 · <button type="button" className="linklike" onClick={() => setReplyTo(null)}>취소</button>
            </p>
          )}
          <Editor value={draft} onChange={setDraft} />
          <button type="submit">등록</button>
        </form>
      )}
    </section>
  );
}

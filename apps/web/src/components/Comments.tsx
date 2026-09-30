import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { emptyDocument, type CommentView, type DocNode } from '@workfluence/shared';
import { api } from '../api';
import { useConfirm } from './ConfirmDialog';
import { Editor } from './Editor';
import { FormActions, Notice } from './ui';

/** 댓글 본문은 페이지와 같은 문서 형식이다 (FR-420). 표시는 같은 편집기를 읽기 전용으로 쓴다 */
function Body({ doc }: { doc: DocNode }) {
  return <Editor value={doc} editable={false} />;
}

/**
 * 댓글 (P3_설계서_Content 5절).
 *
 * 지울 수 있는지는 **서버가 내려 준 `canDelete`를 쓴다.** 화면이 규칙을 다시 구현하면
 * 서버와 어긋나고, 어긋난 쪽이 화면이면 "버튼은 있는데 눌러도 안 되는" 상태가 된다.
 *
 * 페이지 보기의 한 구획이다(P17 설계서 J.5.6). 답은 `.comment.reply`로 들인다(예전의 인라인 여백을 옮겼다). **지우기 전에 묻는다**(J.5.10) —
 * 화면에서 되살리는 길이 없다. 쓰는 칸의 보이는 이름은 `label`이 아니라 제목이다 — 쓰는 칸은 `contenteditable`이라 `label`이 묶이지 않는다
 * (J.7 — 예전의 `label`은 아무 칸도 가리키지 않았다). 칸의 이름은 편집기의 `aria-label`이 같은 글로 붙인다(FR-1820)
 */
export function Comments({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<CommentView[]>([]);
  const [draft, setDraft] = useState<DocNode>(emptyDocument());
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();

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

  const roots = rows.filter((c) => !c.parentId);
  const childrenOf = (id: string) => rows.filter((c) => c.parentId === id);

  const remove = async (c: CommentView) => {
    // 원 댓글을 지우면 서버는 답을 남기지만 이 목록은 원 댓글 아래에만 답을 그린다 — 답이 함께 안 보이게 되는 것을 미리 말한다
    const replies = c.parentId ? 0 : childrenOf(c.id).length;
    // 확정 단추는 "삭제"를 품지 않는다 — 시험이 부른 단추와 확정 단추를 헷갈리지 않게(J.5.10)
    const ok = await confirm({
      title: '이 댓글을 지울까요?',
      body: (
        <p>
          {c.createdByName}님의 댓글을 지운다. 화면에서 되살릴 수 없다.
          {replies > 0 && ` 달린 답 ${replies}개도 보이지 않게 된다.`}
        </p>
      ),
      confirmLabel: '지운다',
    });
    if (!ok) return;
    setError(null);
    try {
      await api(`/api/comments/${c.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const item = (c: CommentView, isReply: boolean) => (
    <li key={c.id} className={isReply ? 'comment reply' : 'comment'}>
      <div className="comment-meta actions">
        <span>
          {c.createdByName} · <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString('ko-KR')}</time>
        </span>
        {/* 대댓글은 한 단계까지다 (FR-421) — 답에는 답 버튼을 두지 않는다 */}
        {canWrite && !isReply && (
          <button type="button" className="subtle sm" onClick={() => setReplyTo(c.id)}>
            답하기
          </button>
        )}
        {c.canDelete && (
          <button type="button" className="danger sm" onClick={() => void remove(c)}>
            삭제
          </button>
        )}
      </div>
      <Body doc={c.body} />
    </li>
  );

  const writeLabel = replyTo ? '답 쓰기' : '댓글 쓰기';

  return (
    <section className="doc-section" aria-label="댓글">
      <h2>
        댓글 {rows.length > 0 && <span className="muted small">{rows.length}</span>}
      </h2>
      {dialog}
      {error && <Notice kind="error">{error}</Notice>}
      {rows.length === 0 ? (
        <p className="muted">댓글이 없다.</p>
      ) : (
        <ul className="plain">
          {roots.map((c) => (
            <Fragment key={c.id}>
              {item(c, false)}
              {childrenOf(c.id).map((r) => item(r, true))}
            </Fragment>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={submit}>
          <h3>{writeLabel}</h3>
          {replyTo && (
            <p className="muted small">
              답하는 중 ·{' '}
              <button type="button" className="subtle sm" onClick={() => setReplyTo(null)}>
                취소
              </button>
            </p>
          )}
          <div className="comment-editor">
            <Editor value={draft} onChange={setDraft} ariaLabel={writeLabel} toolbar="compact" />
          </div>
          <FormActions>
            <button type="submit" className="primary">
              등록
            </button>
          </FormActions>
        </form>
      )}
    </section>
  );
}

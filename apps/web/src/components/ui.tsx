import { Children, cloneElement, isValidElement, useEffect, type ReactElement, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

/**
 * 공통 부품 (P17 설계서 J.5). 모든 화면이 이 한 벌로 머리·폼·알림·목록을 그린다 — 화면별 CSS는 두지 않는다(NFR-171).
 *
 * - **라벨 글은 이름만**(J.5.3) — "필수"·단위·도움말은 label 밖에 둔다. 시험은 라벨로 칸을 찾는다(Testing Library는 정확 일치)
 * - 도움말·오류는 칸 아래에 있고 칸의 `aria-describedby`로 이어진다. 오류가 있으면 `aria-invalid`(FR-1855)
 */

/** 경로의 구역 이름 — 탭 제목과 주 메뉴가 같이 쓴다 (FR-1854) */
export function sectionOf(pathname: string): string {
  if (pathname.startsWith('/admin')) return '관리';
  if (pathname.startsWith('/llm')) return 'LLM 질문';
  if (pathname.startsWith('/search') || pathname.startsWith('/labels')) return '검색';
  if (pathname.startsWith('/trash')) return '휴지통';
  if (pathname.startsWith('/notifications')) return '알림함';
  if (pathname.startsWith('/change-password')) return '비밀번호 변경';
  return '스페이스';
}

/** 탭 제목 — "{제목} - {구역} - workfluence". 예전에는 모든 탭이 "workfluence"라 탭·방문 기록이 구분되지 않았다 (FR-1854) */
export function useDocumentTitle(title: string | null | undefined) {
  const { pathname } = useLocation();
  useEffect(() => {
    const section = sectionOf(pathname);
    document.title = title ? (title === section ? `${title} - workfluence` : `${title} - ${section} - workfluence`) : 'workfluence';
  }, [title, pathname]);
}

/** 화면의 폭 (J.3.4) — wide 1440(목록·표) · form 800(폼만) · read 760(문서) · full 상한 없음(감사로그) */
export function Page({ width = 'wide', children, className }: { width?: 'wide' | 'form' | 'read' | 'full'; children: ReactNode; className?: string }) {
  const w = width === 'wide' ? '' : ` w-${width}-page`;
  return <div className={`page${w}${className ? ` ${className}` : ''}`}>{children}</div>;
}

export type Crumb = { label: string; to?: string };

/** 빵부스러기 — **스페이스 안에서만** 쓴다. 마지막은 링크가 아닌 글(J.3.5) */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav className="crumbs" aria-label="현재 위치">
      <ol>
        {items.map((c, i) => (
          <li key={`${i}-${c.label}`}>
            {c.to && i < items.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === items.length - 1 ? 'page' : undefined}>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * 화면 머리 — 빵부스러기(있을 때만) · h1 · 오른쪽 조치 · 설명 한 줄. 화면마다 h1은 하나다(FR-1854).
 * `title`이 글이면 탭 제목도 바꾼다. 글이 아니면(`titleText`로) 따로 준다
 */
export function PageHeader({
  title,
  titleText,
  actions,
  description,
  crumbs,
}: {
  title: ReactNode;
  titleText?: string;
  actions?: ReactNode;
  description?: ReactNode;
  crumbs?: Crumb[];
}) {
  useDocumentTitle(titleText ?? (typeof title === 'string' ? title : null));
  return (
    <header className="page-header">
      <div className="titles">
        {crumbs && <Breadcrumbs items={crumbs} />}
        <h1>{title}</h1>
        {description && <p className="description">{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

type NoticeKind = 'error' | 'success' | 'warning' | 'info';
const NOTICE_ROLE: Record<NoticeKind, 'alert' | 'status' | 'note'> = { error: 'alert', success: 'status', warning: 'note', info: 'status' };

/**
 * 알림띠 (J.5.7) — 조치한 폼·구획 **바로 위**에 둔다. 앞머리의 기호와 낱말("× 오류" 등)은 CSS가 붙여 글에 들어가지 않는다 —
 * 알림 문장을 그대로 보는 시험이 그대로 통한다. 역할은 기본이 뜻을 따르고(`role`로 바꾼다), `role={null}`이면 두지 않는다
 */
export function Notice({ kind, children, role, id }: { kind: NoticeKind; children: ReactNode; role?: 'alert' | 'status' | 'note' | null; id?: string }) {
  const r = role === null ? undefined : (role ?? NOTICE_ROLE[kind]);
  return (
    <div className={`notice ${kind}`} role={r} id={id}>
      {children}
    </div>
  );
}

/** 칸 하나에 도움말·오류를 잇는다 — 자식 칸에 `aria-describedby`·`aria-invalid`·`required`를 더한다 */
function wire(child: ReactNode, id: string, help: ReactNode, error: ReactNode, required: boolean | undefined): ReactNode {
  const only = Children.toArray(child);
  if (only.length !== 1 || !isValidElement(only[0])) return child;
  const el = only[0] as ReactElement<Record<string, unknown>>;
  const described = [help ? `${id}-help` : null, error ? `${id}-err` : null, el.props['aria-describedby'] as string | undefined].filter(Boolean).join(' ') || undefined;
  return cloneElement(el, {
    'aria-describedby': described,
    'aria-invalid': error ? true : el.props['aria-invalid'],
    required: required ?? el.props.required,
  });
}

/** 칸 아래의 도움말과 오류 */
function FieldNotes({ id, help, error }: { id: string; help?: ReactNode; error?: ReactNode }) {
  return (
    <>
      {help && (
        <p id={`${id}-help`} className="field-help">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** 보이는 "필수" — 보조기기는 칸의 `required`로 읽는다 */
export const Required = () => (
  <span className="req" aria-hidden="true">
    필수
  </span>
);

/**
 * 위 라벨 칸 (J.5.3) — label(이름만) → 칸 → 도움말 → 오류. 칸의 id는 `id`와 같아야 한다.
 * `label`을 비우면 라벨 없이 칸만 잇는다(체크박스를 감싼 label 등)
 */
export function Field({
  id,
  label,
  required,
  help,
  error,
  children,
}: {
  id: string;
  label?: ReactNode;
  required?: boolean;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      {label && (
        <label htmlFor={id}>
          {label}
          {required && <Required />}
        </label>
      )}
      {wire(children, id, help, error, required)}
      <FieldNotes id={id} help={help} error={error} />
    </div>
  );
}

/**
 * 구획 폼 (J.5.4, 착수 쟁점 6) — 흰 상자 안에 h2(또는 legend) → 윗선 2px → 줄 목록. 한 줄은 `FormRow`.
 * `as="fieldset"`이면 `legend`로 이름을 붙인다(운영 설정의 묶음처럼 한 폼 안의 여러 구획)
 */
export function FormSection({
  title,
  titleId,
  description,
  children,
  as = 'section',
  label,
  className,
}: {
  title?: ReactNode;
  titleId?: string;
  description?: ReactNode;
  children: ReactNode;
  as?: 'section' | 'fieldset' | 'div';
  /** 구역의 이름(`aria-label`) — 시험이 구역으로 찾는 곳은 지금 이름을 그대로 둔다 */
  label?: string;
  className?: string;
}) {
  const cls = `form-section${className ? ` ${className}` : ''}`;
  if (as === 'fieldset') {
    return (
      <fieldset className={cls} aria-label={label}>
        {title && <legend id={titleId}>{title}</legend>}
        {description && <p className="form-description">{description}</p>}
        {children}
      </fieldset>
    );
  }
  const Tag = as;
  return (
    <Tag className={cls} aria-label={label} aria-labelledby={!label && title && titleId ? titleId : undefined}>
      {title && <h2 id={titleId}>{title}</h2>}
      {description && <p className="form-description">{description}</p>}
      {children}
    </Tag>
  );
}

/** 구획 폼의 줄 목록(윗선 2px) */
export function FormRows({ children }: { children: ReactNode }) {
  return <div className="form-rows">{children}</div>;
}

/**
 * 구획 폼의 한 줄 — [라벨 열 160px] + [칸 → 도움말·오류]. `top`은 textarea 줄처럼 라벨을 위에 맞춘다.
 * `labelAs="span"`은 칸이 여럿인 줄(라디오 묶음 등) — label 대신 글로 두고 칸들이 각자 이름을 가진다
 */
export function FormRow({
  id,
  label,
  required,
  help,
  error,
  children,
  top,
  labelAs = 'label',
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  top?: boolean;
  labelAs?: 'label' | 'span';
}) {
  return (
    <div className={`form-row${top ? ' top' : ''}`}>
      <div className="row-label">
        {labelAs === 'label' ? (
          <label htmlFor={id}>{label}</label>
        ) : (
          <span className="label-text" id={`${id}-label`}>
            {label}
          </span>
        )}
        {required && <Required />}
      </div>
      <div className="row-field">
        {labelAs === 'label' ? wire(children, id, help, error, required) : children}
        <FieldNotes id={id} help={help} error={error} />
      </div>
    </div>
  );
}

/** 폼 맨 아래의 단추 줄 — 주 단추가 먼저 */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}

/** 거르기 줄 (J.5.4) — 칸마다 라벨 + 칸, 거르기 단추, 오른쪽 끝 건수(`aria-live`) */
export function FilterBar({ children, count, label = '거르기', onSubmit }: { children: ReactNode; count?: ReactNode; label?: string; onSubmit?: () => void }) {
  return (
    <form
      className="filter-bar"
      role="search"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
      {count !== undefined && (
        <span className="count" aria-live="polite">
          {count}
        </span>
      )}
    </form>
  );
}

/** 빈 상태 (J.5.9) — 한 문장 · 설명 · 할 수 있는 조치 하나 */
export function EmptyState({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {description && <p>{description}</p>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

/** 불러오는 동안 — 같은 자리에 한 줄 */
export function Loading({ children = '불러오는 중…' }: { children?: ReactNode }) {
  return <p className="loading">{children}</p>;
}

/** 상태 배지 (J.5.8) — 기호는 CSS가 붙인다. ok 활성·연결됨 · wait 승인 대기 · bad 잠김·정지 · paused 중지됨 · neutral 종류·역할 */
export function StatusBadge({ kind, children }: { kind: 'ok' | 'wait' | 'bad' | 'paused' | 'neutral'; children: ReactNode }) {
  const cls = kind === 'ok' ? 'badge ok' : kind === 'wait' ? 'badge wait' : kind === 'bad' ? 'badge fail' : kind === 'paused' ? 'badge paused' : 'badge';
  return <span className={cls}>{children}</span>;
}

/** 코드 블록 — 명령·임시 값처럼 그대로 옮겨 적을 것 */
export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div className="code-block">
      <pre aria-label={label}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

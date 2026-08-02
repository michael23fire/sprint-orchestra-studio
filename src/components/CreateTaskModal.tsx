import { useState, useEffect, useMemo, useRef } from 'react';
import type { Ticket, TicketStatus, IssueType } from '../types/ticket';
import { EPIC_STATUS_OPTIONS, ISSUE_TYPE_META, normalizeStatusForIssueType, labelColor } from '../types/ticket';
import { useCurrentUser, USERS } from '../context/UserContext';
import { useSpaces } from '../context/SpaceContext';
import { useTickets } from '../context/TicketContext';
import { usersInSpace } from '../utils/issueUserFields';
import { effectiveSpaceMemberIds } from '../types/space';
import { aiApi, labelApi } from '../api';
import type { LabelDto, SemanticSearchHitDto } from '../api';
import { IssueKeyChip } from './IssueKeyChip';

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'in_review', label: 'In Review' },
  { value: 'done', label: 'Done' },
];

const CREATABLE_TYPES: IssueType[] = ['epic', 'story', 'task', 'bug'];

interface CreateTaskModalProps {
  initialStatus?: TicketStatus;
  nextId?: string;
  allowedIssueTypes?: IssueType[];
  /** When set (e.g. creating from Board), the issue joins this sprint instead of Backlog. */
  sprintId?: string;
  sprintName?: string;
  onConfirm?: (ticket: Ticket) => void;
  onClose: () => void;
}

export function CreateTaskModal({
  initialStatus = 'planned',
  nextId: nextIdProp,
  allowedIssueTypes = CREATABLE_TYPES,
  sprintId,
  sprintName,
  onConfirm,
  onClose,
}: CreateTaskModalProps) {
  const { currentUser } = useCurrentUser();
  const { currentSpace } = useSpaces();
  const { nextId: ctxNextId, addTicket } = useTickets();
  const resolvedNextId = nextIdProp ?? ctxNextId;
  const spaceAssignees = useMemo(
    () => usersInSpace(USERS, effectiveSpaceMemberIds(currentSpace)),
    [currentSpace],
  );

  const [issueType, setIssueType] = useState<IssueType>(
    allowedIssueTypes.includes('epic') ? 'epic' : allowedIssueTypes[0],
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TicketStatus>(initialStatus);
  const [assignee, setAssignee] = useState('');
  const [storyPoints, setStoryPoints] = useState('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [spaceLabels, setSpaceLabels] = useState<LabelDto[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);

  // AI-assisted drafting (POST /api/ai/draft-task -> ai-service, see src/api/aiApi.ts) — a rough
  // description in, a structured title/labels/estimate/dependencies draft back. Never blocks manual
  // entry: the fields it fills stay editable, and a provider/model failure surfaces as a message
  // here rather than breaking the form (ai-service's own degradation strategy already guarantees a
  // response either way — see ai-service/app/drafting/service.py — this is the UI-side reflection of
  // that same "never leave the user stuck" principle).
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiDegraded, setAiDegraded] = useState(false);
  const [aiDependencies, setAiDependencies] = useState<string[]>([]);
  /** What the last successful AI draft actually changed — the only positive confirmation the user
   *  gets that the call did something, since the fields it fills are the same ones they can edit by
   *  hand (a silently-unchanged-looking title otherwise reads as "nothing happened"). */
  const [aiApplied, setAiApplied] = useState<string[] | null>(null);

  // Duplicate-issue check: explicit "Check for duplicates" button (not auto-triggered while typing —
  // firing a search on every keystroke pause was surprising and, worse, ran the search against
  // half-finished text) — semantic search (POST /api/ai/search, no LLM) against the description,
  // surfacing existing issues that might already cover this. Purely informational — a failed search
  // is swallowed the same way spaceLabels' fetch below is, since it must never block issue creation.
  const [dupHits, setDupHits] = useState<SemanticSearchHitDto[] | null>(null);
  const [dupLoading, setDupLoading] = useState(false);
  const [dupChecked, setDupChecked] = useState(false);

  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    labelApi.getBySpace(Number(currentSpace.id))
      .then((fetched) => { if (!cancelled) setSpaceLabels(fetched); })
      .catch(() => { /* label suggestions are a nicety — a failed fetch shouldn't block issue creation */ });
    return () => { cancelled = true; };
  }, [currentSpace]);

  async function handleCheckDuplicates() {
    const query = `${title} ${description}`.trim();
    if (!query || dupLoading) return;
    setDupLoading(true);
    setDupChecked(false);
    try {
      // `score` is real cosine similarity (0-1) — the backend only returns results clearing a
      // minimum-relevance floor server-side (excludes noisy attachment-OCR chunks too — see
      // ai-service/app/search/service.py), so an empty result here means "genuinely nothing similar
      // enough," not just "these were the least-bad top 3." Still purely informational — never
      // blocks issue creation either way.
      const res = await aiApi.search(query, [Number(currentSpace.id)], 3);
      setDupHits(res.results);
    } catch {
      setDupHits([]);
    } finally {
      setDupLoading(false);
      setDupChecked(true);
    }
  }

  async function handleAiDraft() {
    if (!description.trim() || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setAiApplied(null);
    try {
      const { draft, degraded } = await aiApi.draftTask(
        description.trim(),
        spaceLabels.map((l) => l.name),
      );
      const applied: string[] = ['title'];
      setTitle(draft.title);
      if (allowedIssueTypes.includes(draft.issueType)) {
        setIssueType(draft.issueType);
        applied.push('type');
      }
      if (draft.labels.length > 0) {
        setSelectedLabels((prev) => Array.from(new Set([...prev, ...draft.labels])));
        applied.push(`${draft.labels.length} label${draft.labels.length !== 1 ? 's' : ''}`);
      }
      if (draft.estimateStoryPoints != null) {
        setStoryPoints(String(draft.estimateStoryPoints));
        applied.push('estimate');
      }
      setAiDependencies(draft.dependencies);
      setAiDegraded(degraded);
      setAiApplied(applied);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI draft failed — try again or fill the form manually.');
    } finally {
      setAiLoading(false);
    }
  }

  function toggleLabel(name: string) {
    setSelectedLabels((prev) => (prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name]));
  }

  useEffect(() => {
    if (!allowedIssueTypes.includes(issueType)) {
      setIssueType(allowedIssueTypes[0]);
    }
  }, [allowedIssueTypes, issueType]);

  useEffect(() => {
    setStatus((current) => issueType === 'epic' ? 'planned' : normalizeStatusForIssueType(issueType, current));
  }, [issueType]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const assigneeUser = assignee ? USERS.find((u) => u.name === assignee) : undefined;
    const assignToSprint = issueType !== 'epic' && Boolean(sprintId);
    const requiresPoints = assignToSprint && issueType !== 'subtask';
    const parsedPoints = Number(storyPoints);
    if (requiresPoints && !(Number.isFinite(parsedPoints) && parsedPoints > 0)) return;
    const ticket: Ticket = {
      id: resolvedNextId,
      title: title.trim(),
      issueType,
      description: description.trim() || undefined,
      status,
      assignee: assignee || undefined,
      assigneeId: assigneeUser ? Number(assigneeUser.id) : undefined,
      reporter: currentUser.name,
      reporterId: Number(currentUser.id),
      storyPoints: requiresPoints ? parsedPoints : undefined,
      labels: selectedLabels.length ? selectedLabels : undefined,
      startDate: startDate || undefined,
      dueDate: dueDate || undefined,
      ...(assignToSprint
        ? { sprintId, sprint: sprintName || undefined }
        : {}),
    };
    if (onConfirm) {
      onConfirm(ticket);
    } else {
      addTicket(ticket);
      onClose();
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title" id="modal-title">Create Issue</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <form className="modal__form" onSubmit={handleSubmit}>
          <div className="modal__field">
            <label className="modal__label">Issue Type</label>
            <div className="issue-type-picker">
              {allowedIssueTypes.map((type) => {
                const meta = ISSUE_TYPE_META[type];
                return (
                  <button
                    key={type}
                    type="button"
                    className={`issue-type-picker__btn ${issueType === type ? 'issue-type-picker__btn--active' : ''}`}
                    style={{
                      '--type-color': meta.color,
                    } as React.CSSProperties}
                    onClick={() => setIssueType(type)}
                  >
                    <span className="issue-type-picker__icon">{meta.icon}</span>
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="modal__field">
            <label className="modal__label" htmlFor="task-title">
              Title <span className="modal__required">*</span>
            </label>
            <input
              ref={titleRef}
              id="task-title"
              className="modal__input"
              type="text"
              placeholder="What needs to be done?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="modal__field">
            <label className="modal__label" htmlFor="task-description">
              Description
              <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>
                — a rough note works; AI can turn it into a structured draft below
              </span>
            </label>
            <textarea
              id="task-description"
              className="modal__input"
              style={{ minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="e.g. sellers keep uploading huge catalog images and it's slowing down the product list page..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <button
              type="button"
              className="modal__btn"
              style={{ marginTop: 6, background: '#ede9fe', color: '#6d28d9', fontWeight: 600 }}
              onClick={handleAiDraft}
              disabled={!description.trim() || aiLoading}
            >
              {aiLoading ? 'Drafting…' : '✨ AI draft (title / labels / estimate)'}
            </button>
            {aiError && (
              <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: '#dc2626' }}>{aiError}</p>
            )}
            {aiApplied && !aiDegraded && (
              <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: '#16a34a', fontWeight: 600 }}>
                ✓ Applied: {aiApplied.join(', ')} — still editable below.
              </p>
            )}
            {aiDegraded && (
              <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: '#d98226' }}>
                AI drafting was unavailable — filled the title from your description as a starting
                point; labels/estimate were not AI-suggested this time.
              </p>
            )}
            {aiDependencies.length > 0 && (
              <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: '#64748b' }}>
                AI noted possible dependencies (not auto-linked — review and add manually if relevant):{' '}
                {aiDependencies.join(', ')}
              </p>
            )}

            <button
              type="button"
              className="modal__btn"
              style={{ marginTop: 6, background: '#f1f5f9', color: '#334155', fontWeight: 600 }}
              onClick={handleCheckDuplicates}
              disabled={!(title.trim() || description.trim()) || dupLoading}
            >
              {dupLoading && <span className="modal__btn-spinner" aria-hidden />}
              {dupLoading ? 'Checking…' : '🔍 Check for duplicates'}
            </button>

            {dupChecked && !dupLoading && dupHits && dupHits.length === 0 && (
              <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: '#16a34a' }}>
                No similar existing issues found.
              </p>
            )}
            {dupChecked && !dupLoading && dupHits && dupHits.length > 0 && (
              <div style={{
                marginTop: 8, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a',
                borderRadius: 8, fontSize: '0.78rem', color: '#92400e',
              }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <strong>Possibly already covered by an existing issue:</strong>
                  <button
                    type="button"
                    onClick={() => setDupChecked(false)}
                    style={{ border: 'none', background: 'transparent', color: '#92400e', cursor: 'pointer', fontSize: '0.9rem' }}
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </div>
                {dupHits.map((hit) => (
                  <div key={hit.issueId} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: '0.72rem', minWidth: 32 }}>{Math.round(hit.score * 100)}%</span>
                    <IssueKeyChip issueKey={hit.issueKey} size="sm" />
                    <span>{hit.snippet.slice(0, 100)}{hit.snippet.length > 100 ? '…' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="modal__field">
            <label className="modal__label">Labels</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {spaceLabels.length === 0 && (
                <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>No labels in this space yet.</span>
              )}
              {spaceLabels.map((label) => {
                const active = selectedLabels.includes(label.name);
                const { bg, text } = labelColor(label.name);
                return (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => toggleLabel(label.name)}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 999,
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      border: active ? '2px solid transparent' : '1px solid #cbd5e1',
                      background: active ? bg : 'transparent',
                      color: active ? text : '#64748b',
                      cursor: 'pointer',
                    }}
                  >
                    {label.name}
                  </button>
                );
              })}
              {/* AI can suggest a label not yet in this space's list (e.g. it picked one from its
                  own small standard set, see app/drafting/templates/task_draft_system.jinja) —
                  still shown as selected even though it has no LabelDto/id yet. */}
              {selectedLabels.filter((name) => !spaceLabels.some((l) => l.name === name)).map((name) => {
                const { bg, text } = labelColor(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleLabel(name)}
                    style={{
                      padding: '3px 10px', borderRadius: 999, fontSize: '0.78rem', fontWeight: 600,
                      border: '2px solid transparent', background: bg, color: text, cursor: 'pointer',
                    }}
                  >
                    {name} ✕
                  </button>
                );
              })}
            </div>
          </div>

          <div className="modal__field">
            <label className="modal__label" htmlFor="task-status">Status</label>
            <select
              id="task-status"
              className="modal__select"
              value={status}
              disabled={issueType === 'epic'}
              onChange={(e) => setStatus(e.target.value as TicketStatus)}
            >
              {(issueType === 'epic' ? EPIC_STATUS_OPTIONS.slice(0, 1) : STATUS_OPTIONS).map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="modal__field">
            <label className="modal__label" htmlFor="task-assignee">Assignee</label>
            <select
              id="task-assignee"
              className="modal__select"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">Unassigned</option>
              {spaceAssignees.map((u) => (
                <option key={u.id} value={u.name}>{u.name}</option>
              ))}
            </select>
          </div>

          {sprintId && issueType !== 'epic' && issueType !== 'subtask' && (
            <div className="modal__field">
              <label className="modal__label" htmlFor="task-points">
                Story Points <span className="modal__required">*</span>
              </label>
              <input
                id="task-points"
                className="modal__input"
                type="number"
                min="1"
                step="1"
                value={storyPoints}
                onChange={(event) => setStoryPoints(event.target.value)}
                required
              />
            </div>
          )}

          <div className="modal__row">
            <div className="modal__field">
              <label className="modal__label" htmlFor="task-start">Start Date</label>
              <input
                id="task-start"
                className="modal__input"
                type="date"
                value={startDate}
                max={dueDate || undefined}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="modal__field">
              <label className="modal__label" htmlFor="task-due">Due Date</label>
              <input
                id="task-due"
                className="modal__input"
                type="date"
                value={dueDate}
                min={startDate || undefined}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="modal__reporter">
            <span className="modal__reporter-label">Reporter:</span>
            <span className="modal__reporter-value">{currentUser.name}</span>
          </div>

          <p style={{ margin: 0, fontSize: '0.8rem', color: '#94a3b8' }}>
            {sprintId && issueType !== 'epic'
              ? <>This issue will be added to <strong>{sprintName || 'the active sprint'}</strong>.</>
              : <>This issue will be added to the <strong>Backlog</strong> (no sprint assigned).</>}
          </p>

          <div className="modal__footer">
            <button type="button" className="modal__btn modal__btn--cancel" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="modal__btn modal__btn--confirm"
              disabled={
                !title.trim()
                || (Boolean(sprintId)
                  && issueType !== 'epic'
                  && issueType !== 'subtask'
                  && !(Number(storyPoints) > 0))
              }
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

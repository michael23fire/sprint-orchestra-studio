import { useState, useEffect, useRef } from 'react';
import type { Ticket, TicketStatus, IssueType } from '../types/ticket';
import { ISSUE_TYPE_META } from '../types/ticket';
import { useCurrentUser, USERS } from '../context/UserContext';
import { useTickets } from '../context/TicketContext';

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
  onConfirm?: (ticket: Ticket) => void;
  onClose: () => void;
}

export function CreateTaskModal({
  initialStatus = 'planned',
  nextId: nextIdProp,
  allowedIssueTypes = CREATABLE_TYPES,
  onConfirm,
  onClose,
}: CreateTaskModalProps) {
  const { currentUser } = useCurrentUser();
  const { nextId: ctxNextId, addTicket } = useTickets();
  const resolvedNextId = nextIdProp ?? ctxNextId;

  const [issueType, setIssueType] = useState<IssueType>(
    allowedIssueTypes.includes('task') ? 'task' : allowedIssueTypes[0],
  );
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<TicketStatus>(initialStatus);
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!allowedIssueTypes.includes(issueType)) {
      setIssueType(allowedIssueTypes[0]);
    }
  }, [allowedIssueTypes, issueType]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const assigneeUser = assignee ? USERS.find((u) => u.name === assignee) : undefined;
    const ticket: Ticket = {
      id: resolvedNextId,
      title: title.trim(),
      issueType,
      status,
      assignee: assignee || undefined,
      assigneeId: assigneeUser ? Number(assigneeUser.id) : undefined,
      reporter: currentUser.name,
      reporterId: Number(currentUser.id),
      dueDate: dueDate
        ? new Date(dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : undefined,
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
            <label className="modal__label" htmlFor="task-status">Status</label>
            <select
              id="task-status"
              className="modal__select"
              value={status}
              onChange={(e) => setStatus(e.target.value as TicketStatus)}
            >
              {STATUS_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="modal__row">
            <div className="modal__field">
              <label className="modal__label" htmlFor="task-assignee">Assignee</label>
              <select
                id="task-assignee"
                className="modal__select"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {USERS.map((u) => (
                  <option key={u.id} value={u.name}>{u.name}</option>
                ))}
              </select>
            </div>
            <div className="modal__field">
              <label className="modal__label" htmlFor="task-due">Due Date</label>
              <input
                id="task-due"
                className="modal__input"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="modal__reporter">
            <span className="modal__reporter-label">Reporter:</span>
            <span className="modal__reporter-value">{currentUser.name}</span>
          </div>

          <p style={{ margin: 0, fontSize: '0.8rem', color: '#94a3b8' }}>
            This issue will be added to the <strong>Backlog</strong> (no sprint assigned).
          </p>

          <div className="modal__footer">
            <button type="button" className="modal__btn modal__btn--cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="modal__btn modal__btn--confirm" disabled={!title.trim()}>Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}

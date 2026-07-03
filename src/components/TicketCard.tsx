import type { Ticket } from '../types/ticket';
import { ISSUE_TYPE_META, PRIORITY_META } from '../types/ticket';
import { AssigneeAvatar } from './AssigneeAvatar';
import { EpicPill, IssueKeyChip } from './IssueKeyChip';

const CalendarIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
    <path d="M11 2h1.5c.3 0 .5.2.5.5v9c0 .3-.2.5-.5.5h-11c-.3 0-.5-.2-.5-.5v-9c0-.3.2-.5.5-.5H3V1h1v1h6V1h1v1zM3 6v5h8V6H3z" />
  </svg>
);

interface TicketCardProps {
  ticket: Ticket;
  onClick?: () => void;
  /** `parent` = board root issue (larger). `subtask` = nested child (compact). */
  variant?: 'default' | 'subtask' | 'parent';
  /** When board hides nested children, show how many exist (open detail to view). */
  hiddenChildCount?: number;
  showIssueKey?: boolean;
  showDueDate?: boolean;
  showAssignee?: boolean;
  showWorkType?: boolean;
  showPriority?: boolean;
  epicKey?: string;
  showEpic?: boolean;
  /** When a subtask sits in a different column than its parent (board), show parent issue key — common Jira-style cue. */
  parentIssueKey?: string;
}

type DueLevel = 'safe' | 'warning' | 'danger' | 'overdue' | 'done' | 'default';

function dueLevelFor(ticket: Ticket): DueLevel {
  if (!ticket.dueDate) return 'default';
  if (ticket.status === 'done') return 'done';
  const due = new Date(ticket.dueDate);
  if (Number.isNaN(due.getTime())) return 'default';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 1) return 'danger';
  if (daysLeft <= 3) return 'warning';
  return 'safe';
}

function dueCountdownText(ticket: Ticket): string | null {
  if (!ticket.dueDate || ticket.status === 'done') return null;
  const due = new Date(ticket.dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  if (daysLeft < 0) {
    const overdueDays = Math.abs(daysLeft);
    return `overdue ${overdueDays}d`;
  }
  if (daysLeft === 0) return 'today';
  if (daysLeft === 1) return '1 day left';
  return `${daysLeft} days left`;
}

export function TicketCard({
  ticket,
  onClick,
  variant = 'default',
  hiddenChildCount,
  showIssueKey = true,
  showDueDate = true,
  showAssignee = true,
  showWorkType = true,
  showPriority = true,
  epicKey,
  showEpic = true,
  parentIssueKey,
}: TicketCardProps) {
  const assignees = ticket.assignees ?? (ticket.assignee ? [ticket.assignee] : []);
  const isSub = variant === 'subtask';
  const isParent = variant === 'parent';
  const showParentLink = Boolean(isSub && parentIssueKey);
  /** Nested under parent on board: show parent key in meta (detached uses bookmark instead). */
  const showNestedParentRef = Boolean(isSub && ticket.parentId && !showParentLink);
  const typeMeta = ISSUE_TYPE_META[ticket.issueType ?? 'task'];
  const priorityMeta = ticket.priority ? PRIORITY_META[ticket.priority] : null;
  const dueLevel = dueLevelFor(ticket);
  const dueCountdown = dueCountdownText(ticket);

  const articleClass = `ticket-card ${isSub ? 'ticket-card--subtask' : ''} ${showParentLink ? 'ticket-card--subtask-detached' : ''} ${isParent ? 'ticket-card--parent' : ''}`;

  const cardInner = (
    <>
      <header className="ticket-card__identity">
        {(showIssueKey || isSub) && (
          <div className="ticket-card__identity-key">
            {isSub && (
              <span className="ticket-card__subtask-ribbon">Subtask</span>
            )}
            {showIssueKey && (
              <>
                <IssueKeyChip
                  issueKey={ticket.id}
                  variant={isParent ? 'parent' : isSub ? 'sub' : 'default'}
                  size={isSub ? 'sm' : isParent ? 'md' : 'md'}
                />
                {showNestedParentRef && ticket.parentId && (
                  <span className="ticket-card__parent-chip" title={`Parent issue ${ticket.parentId}`}>
                    <span className="ticket-card__parent-chip-sep" aria-hidden>
                      ·
                    </span>
                    <span className="ticket-card__parent-chip-label">Parent</span>
                    <IssueKeyChip issueKey={ticket.parentId} size="sm" variant="sub" className="ticket-card__parent-keychip" />
                  </span>
                )}
              </>
            )}
          </div>
        )}
        <h3 className="ticket-card__title">{ticket.title}</h3>
      </header>

      <div className="ticket-card__details">
        {(showWorkType || (showPriority && priorityMeta)) && (
          <div className="ticket-card__badges">
            {showWorkType && (
              <span className="ticket-card__badge" style={{ color: typeMeta.color, borderColor: `${typeMeta.color}55`, background: `${typeMeta.color}14` }}>
                <span aria-hidden>{typeMeta.icon}</span>
                {typeMeta.label}
              </span>
            )}
            {showPriority && priorityMeta && (
              <span className="ticket-card__badge ticket-card__badge--priority" style={{ color: priorityMeta.color, borderColor: `${priorityMeta.color}55`, background: `${priorityMeta.color}12` }}>
                <span aria-hidden>{priorityMeta.icon}</span>
                {priorityMeta.label}
              </span>
            )}
          </div>
        )}
        {showEpic && epicKey && (
          <div className="ticket-card__detail-slot ticket-card__detail-slot--epic">
            <EpicPill epicKey={epicKey} />
          </div>
        )}
        {showDueDate && ticket.dueDate && (
          <div className="ticket-card__detail-slot ticket-card__detail-slot--due">
            <div className="ticket-card__meta">
              <span className={`ticket-card__meta-item ticket-card__meta-item--due ticket-card__meta-item--due-${dueLevel}`}>
                <CalendarIcon />
                {ticket.dueDate}
                {dueCountdown && <span className="ticket-card__due-countdown">({dueCountdown})</span>}
              </span>
            </div>
          </div>
        )}
        {hiddenChildCount != null && hiddenChildCount > 0 && (
          <p className="ticket-card__child-hint">
            {hiddenChildCount} subtask{hiddenChildCount !== 1 ? 's' : ''} — open card to view
          </p>
        )}
        {showAssignee && assignees.length > 0 && (
          <div className="ticket-card__detail-slot ticket-card__detail-slot--assignees">
            <div className="ticket-card__assignees">
              {assignees.map((a) => (
                <AssigneeAvatar key={a} name={a} size="card" />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );

  if (showParentLink) {
    return (
      <div
        className="ticket-card-wrap ticket-card-wrap--bookmark ticket-card-wrap--detached-subtask"
        onClick={onClick}
        style={{ cursor: onClick ? 'pointer' : 'default' }}
        role="group"
        aria-label={`${ticket.id} ${ticket.title}, subtask of ${parentIssueKey}`}
      >
        <div
          className="ticket-card__bookmark"
          title={`Parent issue ${parentIssueKey}`}
        >
          <span className="ticket-card__bookmark-glyph" aria-hidden>↳</span>
          <span className="ticket-card__bookmark-text">Subtask of</span>
          <IssueKeyChip issueKey={parentIssueKey!} size="sm" variant="sub" className="ticket-card__bookmark-key" />
        </div>
        <article className={articleClass}>{cardInner}</article>
      </div>
    );
  }

  return (
    <article
      className={articleClass}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {cardInner}
    </article>
  );
}

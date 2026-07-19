export type IssueType = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

export const ISSUE_TYPE_META: Record<IssueType, { label: string; icon: string; color: string }> = {
  epic:    { label: 'Epic',    icon: '⚡', color: '#6366f1' },
  story:   { label: 'Story',   icon: '📖', color: '#10b981' },
  task:    { label: 'Task',    icon: '✓',  color: '#3b82f6' },
  bug:     { label: 'Bug',     icon: '🐛', color: '#ef4444' },
  subtask: { label: 'Subtask', icon: '◦',  color: '#64748b' },
};

export type TicketStatus = 'planned' | 'in_progress' | 'blocked' | 'in_review' | 'done';

/** Epics track outcome-level progress with a deliberately simpler workflow. */
export const EPIC_STATUS_OPTIONS: ReadonlyArray<{ value: TicketStatus; label: string }> = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
];

export function normalizeStatusForIssueType(
  issueType: IssueType | undefined,
  status: TicketStatus,
): TicketStatus {
  if (issueType === 'epic' && (status === 'blocked' || status === 'in_review')) {
    return 'in_progress';
  }
  return status;
}

export type TicketPriority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

export const PRIORITY_META: Record<TicketPriority, { label: string; color: string; icon: string }> = {
  highest: { label: 'Highest', color: '#dc2626', icon: '⬆' },
  high:    { label: 'High',    color: '#f97316', icon: '↑' },
  medium:  { label: 'Medium',  color: '#eab308', icon: '→' },
  low:     { label: 'Low',     color: '#3b82f6', icon: '↓' },
  lowest:  { label: 'Lowest',  color: '#94a3b8', icon: '⬇' },
};

export const ALL_PRIORITIES = Object.keys(PRIORITY_META) as TicketPriority[];

export function requiresSprintEstimate(issueType: IssueType | undefined): boolean {
  return issueType === 'story' || issueType === 'task' || issueType === 'bug';
}

export function hasValidStoryPoints(storyPoints: number | undefined): boolean {
  return storyPoints != null && Number.isInteger(storyPoints) && storyPoints > 0;
}

export type TicketLabel = string;

const LEGACY_LABEL_COLORS: Record<string, { bg: string; text: string }> = {
  Feature:       { bg: '#dbeafe', text: '#2563eb' },
  Improvement:   { bg: '#dcfce7', text: '#16a34a' },
  Design:        { bg: '#fce7f3', text: '#db2777' },
  Frontend:      { bg: '#cffafe', text: '#0e7490' },
  Backend:       { bg: '#ffedd5', text: '#c2410c' },
  DevOps:        { bg: '#fef9c3', text: '#a16207' },
  Documentation: { bg: '#f1f5f9', text: '#475569' },
  Testing:       { bg: '#ccfbf1', text: '#0f766e' },
  Security:      { bg: '#ffe4e6', text: '#be123c' },
  Performance:   { bg: '#e0f2fe', text: '#0369a1' },
};

/** Muted palette for labels outside the predefined set; index picked by name hash so a label keeps its color. */
const FALLBACK_LABEL_COLORS: Array<{ bg: string; text: string }> = [
  { bg: '#ede9fe', text: '#6d28d9' },
  { bg: '#fef3c7', text: '#b45309' },
  { bg: '#d1fae5', text: '#047857' },
  { bg: '#fee2e2', text: '#b91c1c' },
  { bg: '#e0e7ff', text: '#4338ca' },
  { bg: '#f3f4f6', text: '#374151' },
];

/**
 * Color for any label. Labels are free-form strings server-side (issue_labels.label),
 * so the UI must render ones it has never seen instead of crashing on a missing map entry.
 */
export function labelColor(label: string): { bg: string; text: string } {
  const known = LEGACY_LABEL_COLORS[label];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return FALLBACK_LABEL_COLORS[hash % FALLBACK_LABEL_COLORS.length];
}

/** Issue types are structural metadata, not labels; strip legacy type-like labels everywhere. */
export function labelsForIssueType(
  _issueType: IssueType | undefined,
  labels: readonly string[] | undefined,
): TicketLabel[] {
  const reservedTypeLabels = new Set(['bug', 'story', 'epic']);
  return (labels ?? []).filter((label): label is TicketLabel => !reservedTypeLabels.has(label.toLowerCase()));
}

/** Reserved API label used to persist Jira-style issue flags without exposing it as a normal label. */
export const FLAGGED_API_LABEL = 'Flagged';

export interface Comment {
  id: string;
  authorId?: number;
  author: string;
  content: string;
  createdAt: string;
}

export interface LinkedIssueItem {
  id: number;
  relation: string;
  linkedIssueKey: string;
  linkedIssueTitle: string;
  createdAt: string;
}

export interface TicketAttachment {
  id: number;
  originalFilename: string;
  contentType?: string;
  sizeBytes: number;
  uploaderName?: string;
  createdAt: string;
  /** False = inline in description/comment only (hidden from the Attachments panel). */
  listInAttachmentPanel?: boolean;
}

export type CodeLinkKind = 'pull_request' | 'commit' | 'branch' | 'repo' | 'other';

export interface TicketCodeLink {
  id: number;
  url: string;
  kind: CodeLinkKind;
  provider: string;
  owner?: string;
  repo?: string;
  refId?: string;
  title?: string;
  state?: string;
  authorLogin?: string;
  creatorName?: string;
  createdAt: string;
  /** GitHub-side activity when known (ISO). */
  lastActivityAt?: string;
}

export interface Ticket {
  id: string;
  dbId?: number;
  /** ISO — from API for status lifecycle */
  createdAt?: string;
  /** ISO — from API last update time */
  updatedAt?: string;
  title: string;
  issueType?: IssueType;
  description?: string;
  status: TicketStatus;
  assignee?: string;
  /** DB user id when synced from API or after picker change */
  assigneeId?: number;
  assignees?: string[];
  reporter?: string;
  reporterId?: number;
  dueDate?: string;
  startDate?: string;
  storyPoints?: number;
  sprint?: string;
  priority?: TicketPriority;
  labels?: TicketLabel[];
  /** Marks work that needs attention without changing its workflow status. */
  flagged?: boolean;
  parentId?: string;
  subtaskIds?: string[];
  sprintId?: string;
  /** Backlog / sprint rank (lower = higher in the list). */
  issueOrder?: number;
  comments?: Comment[];
  linkedIssues?: LinkedIssueItem[];
  attachments?: TicketAttachment[];
  codeLinks?: TicketCodeLink[];
}

import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Ticket, TicketStatus, TicketLabel, TicketPriority, IssueType, Comment } from '../types/ticket';
import { EPIC_STATUS_OPTIONS, labelColor, ALL_PRIORITIES, PRIORITY_META, ISSUE_TYPE_META, labelsForIssueType, normalizeStatusForIssueType, requiresSprintEstimate } from '../types/ticket';
import type { Sprint } from '../types/sprint';
import { USERS } from '../context/UserContext';
import { useSpaces } from '../context/SpaceContext';
import { effectiveSpaceMemberIds } from '../types/space';
import { IssueKeyChip } from './IssueKeyChip';
import { assigneeSelection, reporterSelection, spaceUserPickerOptions } from '../utils/issueUserFields';
import { sprintsForIssueAssignment } from '../utils/sprintPicker';
import { formatJiraActivityTime, formatAbsoluteActivityTime, formatRelativeAgo } from '../utils/relativeTime';
import type { StatusLifecycleSegment } from '../utils/statusLifecycle';
import {
  buildStatusLifecycle,
  formatDurationMinutePrecision,
  formatDurationMs,
  formatLifecycleDate,
  formatStatusLabel,
  isInstantTerminalDone,
  statusLifecycleSegmentColor,
} from '../utils/statusLifecycle';
import { getDescendantKeys, resolveEpicTicket } from '../utils/ticketHierarchy';
import { formatDueDateWithTime } from '../utils/dueDate';

/** Zoom slider at 100% → this many × more pixels/ms than “fit to panel”. */
const LIFECYCLE_BAR_ZOOM_MAX_MULT = 14;
import { attachmentApi, historyApi, issueApi, labelApi } from '../api';
import type { IssueAttachmentDto, IssueHistoryDto, LabelDto } from '../api';
import {
  containsHtmlMarkup,
  escapeCommentHtml,
  findAttachmentById,
  findAttachmentByName,
  prepareCommentHtmlForDisplay,
  resolveAttachmentFromElement,
} from '../utils/commentHtml';
import {
  getAttachmentPreviewKind,
  parseCsv,
  readSpreadsheetRows,
} from '../utils/attachmentPreview';
import {
  createPendingAttachment,
  finalizeEditorHtmlWithUploads,
  insertPendingAttachmentAtCursor,
  revokePendingMap,
  type PendingAttachment,
} from '../utils/pendingAttachments';

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: 'planned',     label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'blocked',     label: 'Blocked' },
  { value: 'in_review',   label: 'In Review' },
  { value: 'done',        label: 'Done' },
];
const LINK_RELATION_OPTIONS = [
  'is blocked by',
  'blocks',
  'is cloned by',
  'clones',
  'is duplicated by',
  'duplicates',
  'relates to',
] as const;
const LINK_RECENT_KEYS_STORAGE = 'jira_link_recent_issue_keys';

/** File-type badge for attachment list / inline chips (Jira-like colors). */
function attachmentTypeBadge(
  contentType?: string | null,
  filename?: string | null,
): { label: string; kind: 'pdf' | 'doc' | 'xls' | 'csv' | 'txt' | 'img' | 'file' } {
  const name = (filename || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('pdf') || name.endsWith('.pdf')) return { label: 'PDF', kind: 'pdf' };
  if (
    ct.includes('wordprocessingml') ||
    ct.includes('msword') ||
    name.endsWith('.docx') ||
    name.endsWith('.doc')
  ) {
    return { label: 'DOC', kind: 'doc' };
  }
  if (
    ct.includes('spreadsheetml') ||
    ct.includes('ms-excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls')
  ) {
    return { label: 'XLS', kind: 'xls' };
  }
  if (ct.includes('csv') || name.endsWith('.csv')) return { label: 'CSV', kind: 'csv' };
  if (
    ct.startsWith('text/') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.log')
  ) {
    return { label: 'TXT', kind: 'txt' };
  }
  if (
    ct.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)
  ) {
    return { label: 'IMG', kind: 'img' };
  }
  return { label: 'FILE', kind: 'file' };
}

const STATUS_COLORS: Record<TicketStatus, string> = {
  planned:     '#8b5cf6',
  in_progress: '#3b82f6',
  blocked:     '#ef4444',
  in_review:   '#f59e0b',
  done:        '#10b981',
};

const ISSUE_TYPE_OPTIONS = Object.keys(ISSUE_TYPE_META) as IssueType[];

function IssueTypeIcon({ type }: { type?: IssueType }) {
  const meta = ISSUE_TYPE_META[type ?? 'task'];
  return (
    <span className="breadcrumb__type-icon" style={{ background: meta.color }}>
      {meta.icon}
    </span>
  );
}

function serializeForUpdate(ticket: Ticket): string {
  return JSON.stringify({
    title: ticket.title ?? '',
    description: ticket.description ?? '',
    issueType: ticket.issueType ?? 'task',
    status: ticket.status,
    assignee: ticket.assignee ?? '',
    assigneeId: ticket.assigneeId ?? null,
    reporter: ticket.reporter ?? '',
    reporterId: ticket.reporterId ?? null,
    dueDate: toInputDate(ticket.dueDate),
    startDate: toInputDate(ticket.startDate),
    storyPoints: ticket.storyPoints ?? null,
    priority: ticket.priority ?? null,
    labels: ticket.labels ?? [],
    flagged: ticket.flagged ?? false,
    sprintId: ticket.sprintId ?? null,
    sprint: ticket.sprint ?? '',
    parentId: ticket.parentId ?? null,
  });
}

interface TicketDetailModalProps {
  ticket: Ticket;
  allTickets: Ticket[];
  sprints?: Sprint[];
  /** May resolve false when the save was rejected (server unreachable) so callers can keep unsaved input. */
  onUpdate: (updated: Ticket) => void | Promise<boolean>;
  onCreateSubtask: (parentId: string, title: string) => void | Promise<boolean>;
  onDeleteTicket?: (ticketId: string) => void;
  onAddComment?: (issueDbId: number, authorId: number, content: string) => void;
  onEditComment?: (issueDbId: number, commentId: number, content: string) => void;
  onDeleteComment?: (issueDbId: number, commentId: number) => void;
  onAddIssueLink?: (issueDbId: number, relation: string, targetIssueKey: string) => Promise<void>;
  onDeleteIssueLink?: (issueDbId: number, linkId: number) => Promise<void>;
  onAddCodeLink?: (issueDbId: number, url: string) => Promise<void>;
  onDeleteCodeLink?: (issueDbId: number, linkId: number) => Promise<void>;
  onRefreshCodeLinks?: (issueDbId: number) => Promise<{ checked: number; updated: number }>;
  currentUserId?: number;
  onOpenTicket: (id: string) => void;
  onClose: () => void;
}

type ActivityTab = 'all' | 'comments' | 'history' | 'worklog';
type EditorAttachTarget = 'description' | 'comment' | 'comment-edit' | null;

/** Fields stored as HTML in the DB — show plain language in History, not raw markup. */
const HISTORY_HTML_FIELDS = new Set(['description', 'comment']);

const MAX_HISTORY_VALUE_CHARS = 420;

function truncateForHistoryPreview(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

function htmlToPlainSummaryForHistory(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) return '';
  if (!/<[a-z][\s\S]*>/i.test(trimmed)) {
    return trimmed.replace(/\s+/g, ' ').trim();
  }
  try {
    const container = document.createElement('div');
    container.innerHTML = trimmed;
    container.querySelectorAll('img').forEach((img) => {
      const name = img.getAttribute('data-attachment-name') || img.getAttribute('alt')?.trim() || 'Image';
      img.replaceWith(document.createTextNode(` [${name}] `));
    });
    container.querySelectorAll('br').forEach((el) => el.replaceWith(document.createTextNode('\n')));
    let text = (container.innerText ?? container.textContent ?? '').replace(/\u00a0/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    text = text.replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
    return text;
  } catch {
    return trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function formatHistoryStoredValue(fieldName: string | null | undefined, raw: string | null | undefined): string {
  if (raw == null || raw.trim() === '') return 'None';
  const isHtmlField = fieldName != null && HISTORY_HTML_FIELDS.has(fieldName);
  const plain = isHtmlField ? htmlToPlainSummaryForHistory(raw) : raw.trim();
  if (!plain) return 'None';
  return truncateForHistoryPreview(plain, MAX_HISTORY_VALUE_CHARS);
}

function mapAttachmentDto(dto: IssueAttachmentDto): NonNullable<Ticket['attachments']>[number] {
  return {
    id: dto.id,
    originalFilename: dto.originalFilename,
    contentType: dto.contentType ?? undefined,
    sizeBytes: dto.sizeBytes,
    uploaderName: dto.uploaderName ?? undefined,
    createdAt: dto.createdAt,
    listInAttachmentPanel: dto.listInAttachmentPanel !== false,
  };
}

const CODE_LINK_KIND_META: Record<
  NonNullable<Ticket['codeLinks']>[number]['kind'],
  { icon: string; label: string; badge: string }
> = {
  pull_request: { icon: '⇅', label: 'Pull request', badge: 'PR' },
  commit: { icon: '◉', label: 'Commit', badge: 'Commit' },
  branch: { icon: '⎇', label: 'Branch', badge: 'Branch' },
  repo: { icon: '▣', label: 'Repository', badge: 'Repo' },
  other: { icon: '🔗', label: 'Link', badge: 'Link' },
};

function CodeLinkRow({
  link,
  onDelete,
}: {
  link: NonNullable<Ticket['codeLinks']>[number];
  onDelete?: () => void;
}) {
  const meta = CODE_LINK_KIND_META[link.kind] ?? CODE_LINK_KIND_META.other;
  const subtitle = [link.owner && link.repo ? `${link.owner}/${link.repo}` : null,
    link.kind === 'pull_request' && link.refId ? `#${link.refId}` : null,
    link.kind === 'commit' && link.refId ? link.refId.substring(0, 7) : null,
    link.kind === 'branch' && link.refId ? link.refId : null,
  ].filter(Boolean).join(' · ');

  const stateClass = link.state ? `ticket-detail__code-state ticket-detail__code-state--${link.state.toLowerCase()}` : '';

  return (
    <div className="ticket-detail__code-row">
      <span className={`ticket-detail__code-icon ticket-detail__code-icon--${link.kind}`} aria-hidden>
        {meta.icon}
      </span>
      <div className="ticket-detail__code-body">
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ticket-detail__code-title"
        >
          {link.title || link.url}
        </a>
        <div className="ticket-detail__code-sub">
          <span className="ticket-detail__code-badge">{meta.badge}</span>
          {subtitle && <span>{subtitle}</span>}
          {link.authorLogin && <span>by {link.authorLogin}</span>}
          {link.state && <span className={stateClass}>{link.state}</span>}
          {link.kind === 'pull_request' && !link.state && (
            <span
              className="ticket-detail__code-meta-hint"
              title="Open / merged / closed comes from the GitHub API. Private repos: save a PAT via Code → Repositories bulk import, or set server GITHUB_TOKEN; then use Refresh."
            >
              No status from GitHub
            </span>
          )}
          {(() => {
            const rel = formatRelativeAgo(link.lastActivityAt ?? link.createdAt);
            return rel ? (
              <span className="ticket-detail__code-time" title={formatAbsoluteActivityTime(link.lastActivityAt ?? link.createdAt)}>
                {rel}
              </span>
            ) : null;
          })()}
        </div>
      </div>
      {onDelete && (
        <button
          type="button"
          className="ticket-detail__code-remove"
          onClick={onDelete}
          title="Remove link"
          aria-label="Remove link"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function toInputDate(dateStr?: string): string {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ticket-detail__row">
      <span className="ticket-detail__row-label">{label}</span>
      <div className="ticket-detail__row-value">{children}</div>
    </div>
  );
}

/* ---- Labels multi-select ---- */
function LabelSelect({ selected, onChange }: { selected: TicketLabel[]; onChange: (v: TicketLabel[]) => void }) {
  const { currentSpace } = useSpaces();
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    const spaceId = Number(currentSpace.id);
    if (!Number.isFinite(spaceId) || spaceId <= 0) return;
    labelApi.getBySpace(spaceId)
      .then(setLabels)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load labels'));
  }, [currentSpace.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function toggle(label: TicketLabel) {
    const selectedMatch = selected.find((item) => item.toLocaleLowerCase() === label.toLocaleLowerCase());
    onChange(selectedMatch ? selected.filter((item) => item !== selectedMatch) : [...selected, label]);
  }

  async function createLabel() {
    const name = query.trim();
    if (!name) return;
    const existing = labels.find((label) => label.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) {
      if (!selected.some((item) => item.toLocaleLowerCase() === existing.name.toLocaleLowerCase())) {
        onChange([...selected, existing.name]);
      }
      setQuery('');
      return;
    }
    try {
      const created = await labelApi.create(Number(currentSpace.id), name);
      setLabels((prev) => [...prev.filter((item) => item.id !== created.id), created]
        .sort((a, b) => a.name.localeCompare(b.name)));
      onChange([...selected, created.name]);
      setQuery('');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create label');
    }
  }

  async function deleteLabel(label: LabelDto) {
    if (!window.confirm(`Delete "${label.name}" from this space and all of its issues?`)) return;
    try {
      await labelApi.delete(Number(currentSpace.id), label.id);
      setLabels((prev) => prev.filter((item) => item.id !== label.id));
      onChange(selected.filter((item) => item.toLocaleLowerCase() !== label.name.toLocaleLowerCase()));
      window.dispatchEvent(new Event('space-labels-changed'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete label');
    }
  }

  const filtered = labels.filter((label) =>
    label.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const exactMatch = labels.some((label) =>
    label.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase());

  return (
    <div className="label-select" ref={ref}>
      <button type="button" className="label-select__trigger" onClick={() => setOpen((o) => !o)}>
        {selected.length === 0 && <span>None</span>}
        {selected.map((l) => (
          <span
            key={l}
            className="label-chip label-chip--removable"
            style={{ background: labelColor(l).bg, color: labelColor(l).text }}
          >
            {l}
            <button
              type="button"
              className="label-chip__remove"
              style={{ color: labelColor(l).text }}
              onMouseDown={(e) => { e.stopPropagation(); toggle(l); }}
              aria-label={`Remove ${l}`}
            >✕</button>
          </span>
        ))}
      </button>
      {open && (
        <div className="label-select__dropdown">
          <div className="label-select__create">
            <input
              autoFocus
              value={query}
              maxLength={50}
              placeholder="Find or create a label"
              onChange={(event) => { setQuery(event.target.value); setError(null); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createLabel();
                }
              }}
            />
          </div>
          {filtered.map((label) => {
            const isSelected = selected.some((item) =>
              item.toLocaleLowerCase() === label.name.toLocaleLowerCase());
            return (
              <div
                key={label.id}
                className={`label-select__option ${isSelected ? 'label-select__option--selected' : ''}`}
              >
                <button type="button" className="label-select__option-main" onClick={() => toggle(label.name)}>
                  <span className="label-select__check">{isSelected ? '✓' : ''}</span>
                  <span
                    className="label-chip"
                    style={{ background: labelColor(label.name).bg, color: labelColor(label.name).text }}
                  >
                    {label.name}
                  </span>
                </button>
                <button
                  type="button"
                  className="label-select__delete"
                  aria-label={`Delete ${label.name}`}
                  title={`Delete ${label.name} from this space`}
                  onClick={() => void deleteLabel(label)}
                >
                  🗑
                </button>
              </div>
            );
          })}
          {query.trim() && !exactMatch && (
            <button type="button" className="label-select__create-action" onClick={() => void createLabel()}>
              Create “{query.trim()}”
            </button>
          )}
          {filtered.length === 0 && !query.trim() && <p className="label-select__empty">No labels in this space</p>}
          {error && <p className="label-select__error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/* ---- Main component ---- */
export function TicketDetailModal({
  ticket,
  allTickets,
  sprints,
  onUpdate,
  onCreateSubtask,
  onDeleteTicket,
  onAddComment,
  onEditComment,
  onDeleteComment,
  onAddIssueLink,
  onDeleteIssueLink,
  onAddCodeLink,
  onDeleteCodeLink,
  onRefreshCodeLinks,
  currentUserId,
  onOpenTicket,
  onClose,
}: TicketDetailModalProps) {
  const { currentSpace } = useSpaces();
  const [draft, setDraft] = useState<Ticket>({
    ...ticket,
    status: normalizeStatusForIssueType(ticket.issueType, ticket.status),
  });
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [commentHtml, setCommentHtml] = useState('');
  const [activityTab, setActivityTab] = useState<ActivityTab>('comments');
  const [historyItems, setHistoryItems] = useState<IssueHistoryDto[]>([]);
  const [attachments, setAttachments] = useState<Ticket['attachments']>([]);
  const [attachmentPreviewUrls, setAttachmentPreviewUrls] = useState<Record<number, string>>({});
  const [previewAttachment, setPreviewAttachment] = useState<NonNullable<Ticket['attachments']>[number] | null>(null);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewTable, setPreviewTable] = useState<string[][] | null>(null);
  const [previewSheetName, setPreviewSheetName] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [linkRelation, setLinkRelation] = useState<(typeof LINK_RELATION_OPTIONS)[number]>('is blocked by');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkHighlightIndex, setLinkHighlightIndex] = useState(0);
  const [recentLinkIssueKeys, setRecentLinkIssueKeys] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LINK_RECENT_KEYS_STORAGE);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [editingCommentAttachmentNames, setEditingCommentAttachmentNames] = useState<string[]>([]);
  const [epicPickerOpen, setEpicPickerOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const subtaskInputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const linkPickerRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const editorAttachmentInputRef = useRef<HTMLInputElement>(null);
  const commentEditorRef = useRef<HTMLDivElement>(null);
  const editingCommentEditorRef = useRef<HTMLDivElement>(null);
  const descriptionEditorRef = useRef<HTMLDivElement>(null);
  const descPendingRef = useRef(new Map<string, PendingAttachment>());
  const descInsertQueueRef = useRef<PendingAttachment[]>([]);
  const commentPendingRef = useRef(new Map<string, PendingAttachment>());
  const commentEditPendingRef = useRef(new Map<string, PendingAttachment>());
  const [editorAttachTarget, setEditorAttachTarget] = useState<EditorAttachTarget>(null);
  /** Which editor's emoji popover is open (null = closed). */
  const [emojiPickerFor, setEmojiPickerFor] = useState<EditorAttachTarget>(null);
  const [descSaveInProgress, setDescSaveInProgress] = useState(false);
  const [linkDialog, setLinkDialog] = useState<{
    target: EditorAttachTarget;
    displayText: string;
    url: string;
    savedRange: Range | null;
    initialHadSelection: boolean;
  } | null>(null);
  const linkUrlInputRef = useRef<HTMLInputElement>(null);
  const linkTextInputRef = useRef<HTMLInputElement>(null);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  /** Jira-style "⋯" actions menu — destructive actions live here, away from the ✕ close. */
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [codeLinkUrl, setCodeLinkUrl] = useState('');
  const [codeLinkSubmitting, setCodeLinkSubmitting] = useState(false);
  const [codeLinkError, setCodeLinkError] = useState<string | null>(null);
  const [codeLinkRefreshing, setCodeLinkRefreshing] = useState(false);
  const [codeLinkRefreshMsg, setCodeLinkRefreshMsg] = useState<string | null>(null);
  const [statusSaveInProgress, setStatusSaveInProgress] = useState(false);
  const [lifecycleBarTip, setLifecycleBarTip] = useState<{
    seg: StatusLifecycleSegment;
    x: number;
    y: number;
  } | null>(null);
  /** 0 = bar fits panel width; larger = same time proportions, wider total bar and horizontal scroll. */
  const [lifecycleBarZoom, setLifecycleBarZoom] = useState(0);
  const lifecycleBarScrollRef = useRef<HTMLDivElement>(null);
  const [lifecycleBarViewportW, setLifecycleBarViewportW] = useState(0);

  useEffect(() => {
    setDraft({
      ...ticket,
      status: normalizeStatusForIssueType(ticket.issueType, ticket.status),
    });
    setEditingTitle(false);
    setEditingDesc(false);
    setCommentHtml('');
    setCommentEditorOpen(false);
    setAddingSubtask(false);
    setSubtaskTitle('');
    setEditingCommentId(null);
    setEditingCommentText('');
    setEditingCommentAttachmentNames([]);
    setEpicPickerOpen(false);
    setActivityTab('comments');
    setAttachments(ticket.attachments ?? []);
    setLinkRelation('is blocked by');
    setLinkTarget('');
    setLinkPickerOpen(false);
    setLinkHighlightIndex(0);
    setLifecycleBarZoom(0);
  }, [ticket.id]);

  useEffect(() => {
    if (!editingCommentId) return;
    if (!editingCommentEditorRef.current) return;
    editingCommentEditorRef.current.innerHTML = editingCommentText || '';
  }, [editingCommentId]);

  useEffect(() => {
    if (!emojiPickerFor) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.ticket-editor__emoji-wrap')) {
        setEmojiPickerFor(null);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [emojiPickerFor]);

  // Keep server-managed collections (code links, issue links, comments)
  // in sync with the latest ticket prop. These are mutated via dedicated APIs and
  // re-fetched by the context, and would otherwise be stuck on the stale draft
  // snapshot taken when the modal opened. (Attachments load via getByIssue below.)
  // Also merge ticket.dbId when it arrives after the first paint (draft reset is keyed
  // only on ticket.id — without this, Development "Link" no-ops because handlers read a missing dbId).
  useEffect(() => {
    setDraft((prev) => ({
      ...prev,
      dbId: ticket.dbId ?? prev.dbId,
      // `?? prev.*`: a lean list refresh briefly leaves these undefined on the ticket prop —
      // don't blank out collections the user is looking at; hydrate will deliver fresh data.
      codeLinks: ticket.codeLinks ?? prev.codeLinks ?? [],
      linkedIssues: ticket.linkedIssues ?? prev.linkedIssues ?? [],
      comments: ticket.comments ?? prev.comments ?? [],
    }));
  }, [ticket.dbId, ticket.codeLinks, ticket.linkedIssues, ticket.comments]);

  // A rejected optimistic type update can be replaced by a server refresh
  // while this same issue modal is open. Sync hierarchy/type fields when the
  // canonical ticket changes so the UI cannot remain stuck on a fake Subtask.
  // This does not interfere with an unsaved picker change: ticket.issueType
  // itself stays unchanged until an update is submitted.
  useEffect(() => {
    setDraft((prev) => ({
      ...prev,
      issueType: ticket.issueType,
      parentId: ticket.parentId,
      status: normalizeStatusForIssueType(ticket.issueType, ticket.status),
    }));
  }, [ticket.issueType, ticket.parentId, ticket.status]);

  const statusLifecycleSegments = useMemo(
    () => buildStatusLifecycle(historyItems, ticket.createdAt, draft.status),
    [historyItems, ticket.createdAt, draft.status],
  );

  /** Bar omits a zero-width terminal Done slice so proportions stay meaningful; reopen keeps earlier Done spans. */
  const lifecycleBarSegments = useMemo(
    () => statusLifecycleSegments.filter((s) => !isInstantTerminalDone(s)),
    [statusLifecycleSegments],
  );

  const lifecycleTotalMs = useMemo(
    () => lifecycleBarSegments.reduce((acc, s) => acc + Math.max(0, s.durationMs), 0),
    [lifecycleBarSegments],
  );

  const lifecycleBarZoomMult =
    1 + (lifecycleBarZoom / 100) * (LIFECYCLE_BAR_ZOOM_MAX_MULT - 1);
  const lifecycleFitPpm =
    lifecycleBarViewportW > 0 && lifecycleTotalMs > 0
      ? lifecycleBarViewportW / lifecycleTotalMs
      : 0;
  const lifecycleBarUseScrollZoom =
    lifecycleBarZoom > 0 && lifecycleFitPpm > 0 && lifecycleTotalMs > 0;
  const lifecycleTrackWidthPx = lifecycleBarUseScrollZoom
    ? lifecycleTotalMs * lifecycleFitPpm * lifecycleBarZoomMult
    : lifecycleBarViewportW;

  useLayoutEffect(() => {
    if (activityTab !== 'worklog' && activityTab !== 'all') return;
    const el = lifecycleBarScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLifecycleBarViewportW(el.clientWidth));
    ro.observe(el);
    setLifecycleBarViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, [activityTab, ticket.id, ticket.createdAt, statusLifecycleSegments.length]);

  /** Status transitions newest-first for the Work log list. */
  const statusTransitionsNewestFirst = useMemo(
    () =>
      historyItems
        .filter((h) => h.eventType === 'field_change' && h.fieldName === 'status')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [historyItems],
  );

  /** Rank (issueOrder) churn is drag-reorder noise — recorded server-side but hidden from the History tab. */
  const displayedHistoryItems = useMemo(
    () => historyItems.filter((h) => !(h.eventType === 'field_change' && h.fieldName === 'issueOrder')),
    [historyItems],
  );

  /**
   * Pair comment_created history rows with the matching Comment so All/History can show
   * the body under “added a comment” without duplicating a separate comment card.
   */
  const commentsByHistoryId = useMemo(() => {
    const comments = draft.comments ?? [];
    const used = new Set<string>();
    const map = new Map<number, Comment>();
    const createdEvents = displayedHistoryItems
      .filter((h) => h.eventType === 'comment_created')
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const h of createdEvents) {
      const ht = new Date(h.createdAt).getTime();
      let best: Comment | undefined;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const c of comments) {
        if (used.has(c.id)) continue;
        if (h.actorId != null && c.authorId != null && h.actorId !== c.authorId) continue;
        const delta = Math.abs(new Date(c.createdAt).getTime() - ht);
        if (delta < bestDelta && delta <= 15_000) {
          best = c;
          bestDelta = delta;
        }
      }
      if (best) {
        used.add(best.id);
        map.set(h.id, best);
      }
    }
    return map;
  }, [displayedHistoryItems, draft.comments]);

  const commentsForActivityList = useMemo(() => {
    // Comments tab: full list. All: never show standalone comment cards — those belong
    // under the matching “added a comment” history row (avoids the duplicate flash).
    if (activityTab !== 'comments') return [];
    return draft.comments ?? [];
  }, [activityTab, draft.comments]);

  useEffect(() => {
    if (activityTab !== 'worklog' && activityTab !== 'all') setLifecycleBarTip(null);
  }, [activityTab]);

  useEffect(() => {
    if (ticket.dbId == null) return;
    let cancelled = false;
    historyApi.getByIssue(ticket.dbId)
      .then((items) => { if (!cancelled) setHistoryItems(items); })
      .catch(() => { if (!cancelled) setHistoryItems([]); });
    return () => { cancelled = true; };
    // Re-fetch history when comments change so “added a comment” rows stay in sync on All.
  }, [ticket.dbId, ticket.id, ticket.status, ticket.createdAt, ticket.comments]);

  // Always pull fresh comments + attachments when the modal opens so inline
  // `[file]` chips stay in sync after dataset re-seeds (stale cached comments
  // kept old attachment ids/names while getByIssue returned the new files).
  useEffect(() => {
    const spaceId = Number(currentSpace.id);
    if (!Number.isFinite(spaceId) || spaceId <= 0 || !ticket.id) return;
    let cancelled = false;
    issueApi.getByKey(spaceId, ticket.id)
      .then((dto) => {
        if (cancelled) return;
        setDraft((prev) => ({
          ...prev,
          comments: dto.comments?.map((c) => ({
            id: String(c.id),
            authorId: c.authorId,
            author: c.authorName,
            content: c.content,
            createdAt: c.createdAt,
          })) ?? prev.comments ?? [],
        }));
        setAttachments(dto.attachments?.map(mapAttachmentDto) ?? []);
      })
      .catch(() => {
        if (cancelled || ticket.dbId == null) return;
        attachmentApi.getByIssue(ticket.dbId)
          .then((items) => { if (!cancelled) setAttachments(items.map(mapAttachmentDto)); })
          .catch(() => { if (!cancelled) setAttachments([]); });
      });
    return () => { cancelled = true; };
  }, [currentSpace.id, ticket.id, ticket.dbId]);

  useEffect(() => {
    if (!ticket.dbId) return;
    let cancelled = false;
    const oldUrls = attachmentPreviewUrls;
    const imageAttachments = (attachments ?? []).filter((a) => a.contentType?.startsWith('image/'));
    Promise.all(imageAttachments.map(async (a) => {
      if (oldUrls[a.id]) return [a.id, oldUrls[a.id]] as const;
      try {
        const blob = await attachmentApi.download(ticket.dbId!, a.id);
        return [a.id, URL.createObjectURL(blob)] as const;
      } catch {
        return null;
      }
    })).then((pairs) => {
      if (cancelled) return;
      const next: Record<number, string> = {};
      pairs.forEach((pair) => {
        if (!pair) return;
        next[pair[0]] = pair[1];
      });
      setAttachmentPreviewUrls((prev) => {
        Object.entries(prev).forEach(([idStr, url]) => {
          const id = Number(idStr);
          if (!next[id]) URL.revokeObjectURL(url);
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [attachments, ticket.dbId]);

  useEffect(() => {
    return () => {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    };
  }, [previewObjectUrl]);

  useEffect(() => {
    return () => {
      revokePendingMap(descPendingRef.current);
      revokePendingMap(commentPendingRef.current);
      revokePendingMap(commentEditPendingRef.current);
    };
  }, []);

  useEffect(() => {
    if (!editingDesc) return;
    const editor = descriptionEditorRef.current;
    if (!editor) return;
    const initial = draft.description ?? '';
    const hasLegacyAttachmentToken = /\[attachment:/i.test(initial) || /^\s*attachment:/im.test(initial);
    let html: string;
    // Treat HTML tags *or* entities (&nbsp;, &amp;, …) as markup. Otherwise
    // escapeHtml turns `&nbsp;` into `&amp;nbsp;` and the editor shows the
    // entity as literal text.
    if (containsHtmlMarkup(initial)) {
      html = hydrateCommentHtml(initial);
    } else if (hasLegacyAttachmentToken) {
      html = expandAttachmentTokensToHtml(initial);
    } else {
      html = escapeHtml(initial).replace(/\n/g, '<br>');
    }
    editor.innerHTML = html;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Initial mount only — don't re-run on attachmentPreviewUrls change to avoid
    // clobbering user input. Image srcs are patched in the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingDesc]);

  useEffect(() => {
    if (!editingDesc) return;
    const editor = descriptionEditorRef.current;
    if (!editor || descInsertQueueRef.current.length === 0) return;
    editor.focus();
    for (const pending of descInsertQueueRef.current) {
      insertPendingAttachmentAtCursor(editor, pending);
    }
    descInsertQueueRef.current = [];
  }, [editingDesc]);

  // Keep image srcs inside the description editor in sync when previews load,
  // without touching any other DOM (preserves cursor & user typing).
  useEffect(() => {
    if (!editingDesc) return;
    const editor = descriptionEditorRef.current;
    if (!editor) return;
    editor.querySelectorAll('img[data-attachment-id], img[data-attachment-name]').forEach((img) => {
      const idAttr = img.getAttribute('data-attachment-id');
      const nameAttr = img.getAttribute('data-attachment-name');
      const attachment = findAttachmentById(attachments, idAttr) ?? (nameAttr ? findAttachmentByName(attachments, nameAttr) : undefined);
      if (!attachment) return;
      const src = attachmentPreviewUrls[attachment.id];
      if (src && img.getAttribute('src') !== src) {
        img.setAttribute('src', src);
      }
    });
  }, [attachmentPreviewUrls, editingDesc, attachments]);

  useEffect(() => {
    if (!commentEditorOpen) return;
    const editor = commentEditorRef.current;
    if (!editor) return;
    editor.querySelectorAll('img[data-attachment-id], img[data-attachment-name]').forEach((img) => {
      const idAttr = img.getAttribute('data-attachment-id');
      const nameAttr = img.getAttribute('data-attachment-name');
      const attachment = findAttachmentById(attachments, idAttr) ?? (nameAttr ? findAttachmentByName(attachments, nameAttr) : undefined);
      if (!attachment) return;
      const src = attachmentPreviewUrls[attachment.id];
      if (src && img.getAttribute('src') !== src) {
        img.setAttribute('src', src);
      }
    });
  }, [attachmentPreviewUrls, commentEditorOpen, attachments]);

  useEffect(() => {
    if (!linkPickerOpen) return;
    function onOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (linkPickerRef.current && !linkPickerRef.current.contains(target)) {
        setLinkPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [linkPickerOpen]);

  useEffect(() => {
    if (!aiMenuOpen) return;
    function onOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (aiMenuRef.current && !aiMenuRef.current.contains(target)) {
        setAiMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [aiMenuOpen]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    function onOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [moreMenuOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  useEffect(() => {
    if (addingSubtask) subtaskInputRef.current?.focus();
  }, [addingSubtask]);

  const assigneeOptions = useMemo(
    () =>
      spaceUserPickerOptions(USERS, effectiveSpaceMemberIds(currentSpace), {
        id: draft.assigneeId,
        name: draft.assignee,
      }),
    [currentSpace, draft.assigneeId, draft.assignee],
  );

  const reporterOptions = useMemo(
    () =>
      spaceUserPickerOptions(USERS, effectiveSpaceMemberIds(currentSpace), {
        id: draft.reporterId,
        name: draft.reporter,
      }),
    [currentSpace, draft.reporterId, draft.reporter],
  );

  const sprintAssignmentOptions = useMemo(
    () => (sprints ? sprintsForIssueAssignment(sprints, draft.sprintId) : []),
    [sprints, draft.sprintId],
  );
  const canLinkEpic = draft.issueType !== 'epic' && draft.issueType !== 'subtask';
  const epicOptions = useMemo(
    () => allTickets.filter((t) => t.issueType === 'epic' && t.id !== draft.id),
    [allTickets, draft.id],
  );
  /** Direct epic on story/task, or inherited epic for subtasks (from parent). */
  const selectedEpic = useMemo(
    () => resolveEpicTicket(draft, allTickets) ?? null,
    [draft, allTickets],
  );
  const inheritedEpicOnly = draft.issueType === 'subtask' && selectedEpic != null;
  const hasChanges = useMemo(
    () => serializeForUpdate(draft) !== serializeForUpdate(ticket),
    [draft, ticket],
  );
  const panelAttachments = useMemo(
    () => (attachments ?? []).filter((a) => a.listInAttachmentPanel !== false),
    [attachments],
  );
  // The only hard exclusion is the ticket itself (can't link to yourself).
  // Linking the same target with *different* relations is valid in Jira
  // (e.g. "A blocks B" + "A relates to B"), so we do NOT exclude targets
  // that are already linked — we just annotate them below so the user sees
  // the existing relation(s).
  const excludedLinkKeys = useMemo(() => {
    return new Set<string>([ticket.id]);
  }, [ticket.id]);

  // Map of targetKey → list of relations already linked on this draft, used
  // to render a subtle "already linked as blocks" hint in the picker.
  const existingRelationsByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    (draft.linkedIssues ?? []).forEach((l) => {
      const arr = map.get(l.linkedIssueKey) ?? [];
      arr.push(l.relation);
      map.set(l.linkedIssueKey, arr);
    });
    return map;
  }, [draft.linkedIssues]);

  // Sort by the numeric suffix of the issue key, newest first (P1-42 before
  // P1-5). Falls back to string compare when no numeric suffix is found.
  const compareIssueKeyDesc = useCallback((a: Ticket, b: Ticket) => {
    const ra = a.id.match(/(\d+)\s*$/);
    const rb = b.id.match(/(\d+)\s*$/);
    const na = ra ? parseInt(ra[1], 10) : NaN;
    const nb = rb ? parseInt(rb[1], 10) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return nb - na;
    return a.id.localeCompare(b.id);
  }, []);

  // Rank candidates against a search query. Higher score = better match.
  const scoreLinkMatch = useCallback((t: Ticket, q: string): number => {
    const key = t.id.toLowerCase();
    const title = (t.title ?? '').toLowerCase();
    if (key === q) return 1000;
    if (key.startsWith(q)) return 500;
    if (title.startsWith(q)) return 300;
    if (key.includes(q)) return 200;
    if (title.includes(q)) return 100;
    return 0;
  }, []);

  const recentLinkCandidates = useMemo(() => {
    const byKey = new Map(allTickets.map((t) => [t.id, t]));
    return recentLinkIssueKeys
      .map((key) => byKey.get(key))
      .filter((t): t is Ticket => Boolean(t))
      .filter((t) => !excludedLinkKeys.has(t.id))
      .slice(0, 5);
  }, [allTickets, recentLinkIssueKeys, excludedLinkKeys]);

  const recentLinkKeySet = useMemo(
    () => new Set(recentLinkCandidates.map((t) => t.id)),
    [recentLinkCandidates],
  );

  // Full candidate list (below the "Recently viewed" section). When the user
  // is typing this becomes the ranked search result; otherwise it's a plain
  // list of every issue in the space ordered by newest key first.
  const otherLinkCandidates = useMemo(() => {
    const q = linkTarget.trim().toLowerCase();
    const base = allTickets.filter((t) => !excludedLinkKeys.has(t.id));
    if (!q) {
      return base
        .filter((t) => !recentLinkKeySet.has(t.id))
        .sort(compareIssueKeyDesc)
        .slice(0, 20);
    }
    return base
      .map((t) => ({ t, s: scoreLinkMatch(t, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || compareIssueKeyDesc(a.t, b.t))
      .map((x) => x.t)
      .slice(0, 20);
  }, [allTickets, excludedLinkKeys, recentLinkKeySet, linkTarget, compareIssueKeyDesc, scoreLinkMatch]);

  // When searching, recently-viewed is hidden — results are already ranked
  // globally. Otherwise we render both sections (recent first, then rest).
  const showRecentSection = !linkTarget.trim() && recentLinkCandidates.length > 0;

  const pickerItems = useMemo(
    () =>
      showRecentSection
        ? [...recentLinkCandidates, ...otherLinkCandidates]
        : otherLinkCandidates,
    [showRecentSection, recentLinkCandidates, otherLinkCandidates],
  );

  useEffect(() => {
    setLinkHighlightIndex(0);
  }, [linkTarget, linkPickerOpen]);

  function handleClose() {
    if (hasChanges) onUpdate(draft);
    onClose();
  }

  function patch<K extends keyof Ticket>(key: K, value: Ticket[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleToggleFlag() {
    const nextFlagged = !draft.flagged;
    const updated = { ...draft, flagged: nextFlagged };
    setMoreMenuOpen(false);
    setDraft(updated);
    const saved = await Promise.resolve(onUpdate(updated));
    if (saved === false) setDraft((prev) => ({ ...prev, flagged: !nextFlagged }));
  }

  function applyUploadedAttachments(uploaded: IssueAttachmentDto[]) {
    if (uploaded.length === 0) return;
    setAttachments((prev) => {
      const next = [...(prev ?? [])];
      for (const dto of uploaded) {
        const mapped = mapAttachmentDto(dto);
        if (!next.some((a) => a.id === mapped.id)) next.unshift(mapped);
      }
      return next;
    });
  }

  function htmlHasAttachmentMarkers(html: string) {
    return html.includes('data-attachment-name=')
      || html.includes('data-attachment-id=')
      || html.includes('data-pending-attachment-id=');
  }

  async function handleAddComment() {
    if (!ticket.dbId) return;
    const rawHtml = (commentEditorRef.current?.innerHTML ?? commentHtml).trim();
    let composedContent: string;
    try {
      const finalized = await finalizeEditorHtmlWithUploads(ticket.dbId, rawHtml, commentPendingRef.current);
      applyUploadedAttachments(finalized.uploaded);
      composedContent = normalizeCommentHtml(finalized.html);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to upload attachments');
      return;
    }
    if (!stripHtml(composedContent).trim() && !htmlHasAttachmentMarkers(composedContent)) return;
    const now = new Date().toISOString();
    const authorName = (
      currentUserId != null
        ? USERS.find((u) => Number(u.id) === currentUserId)?.name
        : undefined
    ) ?? 'You';
    const comment: Comment = {
      id: `c-${Date.now()}`,
      authorId: currentUserId,
      author: authorName,
      content: composedContent,
      createdAt: now,
    };
    patch('comments', [...(draft.comments ?? []), comment]);
    // Optimistic history so All/History show “added a comment” + body immediately.
    setHistoryItems((prev) => [
      {
        id: -Date.now(),
        issueId: ticket.dbId!,
        actorId: currentUserId ?? null,
        actorName: authorName,
        eventType: 'comment_created',
        fieldName: null,
        fromValue: null,
        toValue: null,
        description: 'added a comment',
        createdAt: now,
      },
      ...prev,
    ]);
    if (onAddComment && currentUserId != null) {
      onAddComment(ticket.dbId, currentUserId, composedContent);
    }
    setCommentHtml('');
    if (commentEditorRef.current) commentEditorRef.current.innerHTML = '';
    setCommentEditorOpen(false);
  }

  function handleCancelCommentEditor() {
    revokePendingMap(commentPendingRef.current);
    setCommentHtml('');
    setCommentEditorOpen(false);
    if (commentEditorRef.current) commentEditorRef.current.innerHTML = '';
  }

  function handleDeleteComment(comment: Comment) {
    patch('comments', (draft.comments ?? []).filter((c) => c.id !== comment.id));
    if (onDeleteComment && ticket.dbId != null) {
      onDeleteComment(ticket.dbId, Number(comment.id));
    }
  }

  function handleStartEditComment(comment: Comment) {
    setEditingCommentId(comment.id);
    const namesFromText = Array.from(getAttachmentNamesFromText(comment.content));
    const namesFromHtml = Array.from(getAttachmentNamesFromHtml(comment.content));
    const initialHtml = containsHtmlMarkup(comment.content)
      ? hydrateCommentHtml(comment.content)
      : expandAttachmentTokensToHtml(comment.content);
    setEditingCommentText(initialHtml);
    setEditingCommentAttachmentNames(Array.from(new Set([...namesFromText, ...namesFromHtml])));
  }

  async function handleSaveEditComment() {
    if (!editingCommentId || !ticket.dbId) return;
    const rawHtml = (editingCommentEditorRef.current?.innerHTML ?? editingCommentText).trim();
    let composedContent: string;
    try {
      const finalized = await finalizeEditorHtmlWithUploads(ticket.dbId, rawHtml, commentEditPendingRef.current);
      applyUploadedAttachments(finalized.uploaded);
      composedContent = normalizeCommentHtml(finalized.html);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to upload attachments');
      return;
    }
    if (!stripHtml(composedContent).trim() && !htmlHasAttachmentMarkers(composedContent)) return;
    patch('comments', (draft.comments ?? []).map((c) =>
      c.id === editingCommentId ? { ...c, content: composedContent } : c,
    ));
    if (onEditComment) {
      onEditComment(ticket.dbId, Number(editingCommentId), composedContent);
    }
    setEditingCommentId(null);
    setEditingCommentText('');
    setEditingCommentAttachmentNames([]);
    if (editingCommentEditorRef.current) editingCommentEditorRef.current.innerHTML = '';
  }

  async function handleCreateSubtask() {
    const title = subtaskTitle.trim();
    if (!title) return;
    const ok = await onCreateSubtask(draft.id, title);
    if (ok === false) return;
    setSubtaskTitle('');
    setAddingSubtask(false);
  }

  function handleDeleteIssue() {
    if (!onDeleteTicket) return;
    if (!confirm(`Delete ${draft.id}? This action cannot be undone.`)) return;
    onDeleteTicket(draft.id);
    onClose();
  }

  function formatTs(ts: string) {
    return formatAbsoluteActivityTime(ts) || ts;
  }

  function openEditorAttachPicker(target: EditorAttachTarget) {
    setEditorAttachTarget(target);
    editorAttachmentInputRef.current?.click();
  }

  function handleEditorAttachFiles(files: FileList | null) {
    if (!files || !editorAttachTarget) return;
    if (!ticket.dbId) {
      alert('Cannot attach: issue is not synced yet.');
      return;
    }
    const selected = Array.from(files);
    const target = editorAttachTarget;

    for (const file of selected) {
      const pending = createPendingAttachment(file);
      if (target === 'description') {
        descPendingRef.current.set(pending.pendingId, pending);
        if (!editingDesc) {
          descInsertQueueRef.current.push(pending);
          setEditingDesc(true);
        } else if (descriptionEditorRef.current) {
          insertPendingAttachmentAtCursor(descriptionEditorRef.current, pending);
        } else {
          descInsertQueueRef.current.push(pending);
        }
      } else if (target === 'comment') {
        commentPendingRef.current.set(pending.pendingId, pending);
        setCommentEditorOpen(true);
        if (commentEditorRef.current) {
          insertPendingAttachmentAtCursor(commentEditorRef.current, pending);
          setCommentHtml(commentEditorRef.current.innerHTML);
        }
      } else if (target === 'comment-edit') {
        commentEditPendingRef.current.set(pending.pendingId, pending);
        if (editingCommentEditorRef.current) {
          insertPendingAttachmentAtCursor(editingCommentEditorRef.current, pending);
          setEditingCommentText(editingCommentEditorRef.current.innerHTML);
        } else {
          setEditingCommentAttachmentNames((prev) => Array.from(new Set([...prev, pending.originalFilename])));
        }
      }
    }

    setEditorAttachTarget(null);
    if (editorAttachmentInputRef.current) editorAttachmentInputRef.current.value = '';
  }

  async function handleSaveDescription() {
    if (!ticket.dbId || !descriptionEditorRef.current) return;
    setDescSaveInProgress(true);
    try {
      const rawHtml = descriptionEditorRef.current.innerHTML;
      const finalized = await finalizeEditorHtmlWithUploads(ticket.dbId, rawHtml, descPendingRef.current);
      applyUploadedAttachments(finalized.uploaded);
      const newDescription = normalizeCommentHtml(finalized.html);
      const prevDescription = draft.description ?? '';
      // Persist immediately so the backend can reconcile embedded attachments (and emit Kafka)
      // without waiting for the modal to close.
      if (newDescription !== prevDescription) {
        const updated: Ticket = { ...draft, description: newDescription };
        setDraft(updated);
        const saved = await Promise.resolve(onUpdate(updated));
        if (saved === false) {
          // The context already alerted; keep the editor open (its DOM is only
          // re-initialized when editingDesc flips) so the user's text survives a retry.
          return;
        }
      } else {
        patch('description', newDescription);
      }
      setEditingDesc(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save description');
    } finally {
      setDescSaveInProgress(false);
    }
  }

  function handleCancelDescriptionEdit() {
    revokePendingMap(descPendingRef.current);
    descInsertQueueRef.current = [];
    setEditingDesc(false);
  }

  function formatRelativeTime(ts: string) {
    return formatJiraActivityTime(ts) || ts;
  }

  function fieldLabel(fieldName?: string | null) {
    const map: Record<string, string> = {
      description: 'Description',
      issueType: 'Issue type',
      storyPoints: 'Story points',
      startDate: 'Start date',
      dueDate: 'Due date',
      issueOrder: 'Rank',
      comment: 'Comment',
    };
    return fieldName ? (map[fieldName] ?? fieldName) : 'Issue';
  }

  function actorInitials(name?: string | null) {
    if (!name) return 'SY';
    const parts = name.trim().split(/\s+/);
    return (parts[0]?.[0] ?? '').toUpperCase() + (parts[1]?.[0] ?? '').toUpperCase();
  }

  function renderHistoryTitle(h: IssueHistoryDto) {
    const actor = h.actorName ?? 'System';
    if (h.eventType === 'comment_created') return `${actor} added a comment`;
    if (h.eventType === 'comment_deleted') return `${actor} deleted a comment`;
    if (h.eventType === 'worklog_created') return `${actor} logged work`;
    if (h.eventType === 'worklog_deleted') return `${actor} deleted a work log`;
    if (h.eventType === 'issue_created') return `${actor} created this issue`;
    // Action events (code_link_added, attachment_uploaded, …) carry a verb phrase
    // in description ("linked a repository") and no fieldName/from/to values.
    if (h.eventType !== 'field_change' && h.description) return `${actor} ${h.description}`;
    return `${actor} updated ${fieldLabel(h.fieldName)}`;
  }

  async function addIssueLink() {
    if (!ticket.dbId || !onAddIssueLink) return;
    const key = linkTarget.trim().toUpperCase();
    if (!key) return;
    // Silent failures confused users: validate the target exists in this space
    // before hitting the API, and surface backend rejections inline.
    const targetExists = allTickets.some((t) => t.id.toUpperCase() === key);
    if (!targetExists) {
      setLinkError(`${key} doesn't exist in this space — pick an issue from the list.`);
      return;
    }
    if (key === ticket.id.toUpperCase()) {
      setLinkError('An issue cannot be linked to itself.');
      return;
    }
    // Prevent the exact same (relation, target) link from being added twice.
    // Linking the same target with a *different* relation is allowed.
    const alreadyExists = (draft.linkedIssues ?? []).some(
      (l) => l.linkedIssueKey.toUpperCase() === key && l.relation === linkRelation,
    );
    if (alreadyExists) {
      setLinkError(`Already linked as "${linkRelation}" → ${key}.`);
      return;
    }
    setLinkError(null);
    try {
      await onAddIssueLink(ticket.dbId, linkRelation, key);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : 'Failed to link the issue.');
      return;
    }
    setRecentLinkIssueKeys((prev) => {
      const next = [key, ...prev.filter((x) => x !== key)].slice(0, 20);
      try {
        localStorage.setItem(LINK_RECENT_KEYS_STORAGE, JSON.stringify(next));
      } catch {}
      return next;
    });
    setDraft((prev) => ({
      ...prev,
      linkedIssues: [
        {
          id: Date.now(),
          relation: linkRelation,
          linkedIssueKey: key,
          linkedIssueTitle: '',
          createdAt: new Date().toISOString(),
        },
        ...(prev.linkedIssues ?? []),
      ],
    }));
    setLinkTarget('');
  }

  async function removeIssueLink(linkId: number) {
    if (!ticket.dbId || !onDeleteIssueLink) return;
    await onDeleteIssueLink(ticket.dbId, linkId);
    setDraft((prev) => ({
      ...prev,
      linkedIssues: (prev.linkedIssues ?? []).filter((l) => l.id !== linkId),
    }));
  }

  async function addCodeLink() {
    const issueDbId = draft.dbId ?? ticket.dbId;
    const url = codeLinkUrl.trim();
    if (!url) return;
    // Strict: only GitHub repo and PR URLs. Anything else either renders as a
    // useless metadata-less "LINK" card (other), is never rendered (commit), or
    // doesn't belong here now that the Code page is PR-only (branch).
    const isPrUrl = /^https?:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+([/?#]|$)/i.test(url);
    const isRepoUrl = /^https?:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+\/?([?#]|$)/i.test(url);
    if (!isPrUrl && !isRepoUrl) {
      setCodeLinkError('Only GitHub repository or pull request URLs are supported — e.g. https://github.com/owner/repo or https://github.com/owner/repo/pull/123.');
      return;
    }
    if (!onAddCodeLink) {
      setCodeLinkError('Code linking is not available in this view.');
      return;
    }
    if (issueDbId == null) {
      setCodeLinkError('This issue is not synced with the server yet (missing id). Try closing and reopening the ticket, or refresh the page.');
      return;
    }
    setCodeLinkError(null);
    setCodeLinkSubmitting(true);
    try {
      await onAddCodeLink(issueDbId, url);
      setCodeLinkUrl('');
    } catch (err) {
      setCodeLinkError(err instanceof Error ? err.message : 'Failed to link');
    } finally {
      setCodeLinkSubmitting(false);
    }
  }

  async function removeCodeLink(linkId: number) {
    const issueDbId = draft.dbId ?? ticket.dbId;
    if (issueDbId == null || !onDeleteCodeLink) return;
    try {
      await onDeleteCodeLink(issueDbId, linkId);
      setDraft((prev) => ({
        ...prev,
        codeLinks: (prev.codeLinks ?? []).filter((l) => l.id !== linkId),
      }));
    } catch {
      // context refresh will re-sync
    }
  }

  async function refreshCodeLinks() {
    const issueDbId = draft.dbId ?? ticket.dbId;
    if (issueDbId == null || !onRefreshCodeLinks) return;
    setCodeLinkRefreshMsg(null);
    setCodeLinkRefreshing(true);
    try {
      const res = await onRefreshCodeLinks(issueDbId);
      setCodeLinkRefreshMsg(
        res.checked === 0
          ? 'No pull requests linked to this issue yet.'
          : res.updated > 0
            ? `Checked ${res.checked} linked item${res.checked === 1 ? '' : 's'} — ${res.updated} updated from GitHub.`
            : `Checked ${res.checked} linked item${res.checked === 1 ? '' : 's'} — titles and statuses already match GitHub.`,
      );
    } catch (err) {
      setCodeLinkRefreshMsg(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setCodeLinkRefreshing(false);
    }
  }

  function formatSize(sizeBytes: number) {
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleSelectAttachmentFiles(files: FileList | null) {
    if (!files) return;
    if (!ticket.dbId) {
      alert('Cannot upload: issue is not synced yet.');
      return;
    }
    const uploads = Array.from(files);
    const failedFiles: string[] = [];
    for (const file of uploads) {
      try {
        const created = await attachmentApi.upload(ticket.dbId, file);
        setAttachments((prev) => [mapAttachmentDto(created), ...(prev ?? [])]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown upload error';
        failedFiles.push(`${file.name} (${msg})`);
        console.error('Attachment upload failed:', file.name, msg);
      }
    }
    if (failedFiles.length > 0) {
      alert(`Failed to upload: ${failedFiles.join(', ')}`);
    }
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  }

  async function handleDownloadAttachment(attachmentId: number, fileName: string) {
    if (!ticket.dbId) return;
    try {
      const blob = await attachmentApi.download(ticket.dbId, attachmentId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert('Failed to download attachment');
    }
  }

  async function openAttachmentPreview(attachment: NonNullable<Ticket['attachments']>[number]) {
    setPreviewAttachment(attachment);
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      setPreviewObjectUrl(null);
    }
    setPreviewText(null);
    setPreviewTable(null);
    setPreviewSheetName(null);

    const previewKind = getAttachmentPreviewKind(attachment.contentType, attachment.originalFilename);
    if (previewKind === 'unsupported') return;
    if (!ticket.dbId) return;
    if (previewKind === 'image' && attachmentPreviewUrls[attachment.id]) return;

    try {
      setPreviewLoading(true);
      const blob = await attachmentApi.download(ticket.dbId, attachment.id);
      if (previewKind === 'image' || previewKind === 'pdf') {
        setPreviewObjectUrl(URL.createObjectURL(blob));
        return;
      }
      if (previewKind === 'text') {
        setPreviewText(await blob.text());
        return;
      }
      if (previewKind === 'csv') {
        setPreviewTable(parseCsv(await blob.text()));
        return;
      }
      if (previewKind === 'spreadsheet') {
        const { sheetName, rows } = await readSpreadsheetRows(blob);
        setPreviewSheetName(sheetName);
        setPreviewTable(rows);
      }
    } catch {
      alert('Failed to load preview');
    } finally {
      setPreviewLoading(false);
    }
  }

  function handleCommentAttachmentClick(event: React.MouseEvent<HTMLElement>) {
    const anchor = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (anchor) {
      event.preventDefault();
      event.stopPropagation();
      window.open(anchor.href, '_blank', 'noopener,noreferrer');
      return;
    }
    const el = (event.target as HTMLElement).closest('[data-attachment-id],[data-attachment-name]') as HTMLElement | null;
    if (!el) return;
    const attachment = resolveAttachmentFromElement(attachments, el);
    if (!attachment) {
      const nameAttr = el.getAttribute('data-attachment-name');
      alert(nameAttr
        ? `Attachment "${nameAttr}" is not available. Refresh the page or re-open this issue.`
        : 'Attachment is not available. Refresh the page or re-open this issue.');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void openAttachmentPreview(attachment);
  }

  function closeAttachmentPreview() {
    setPreviewAttachment(null);
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      setPreviewObjectUrl(null);
    }
    setPreviewText(null);
    setPreviewTable(null);
    setPreviewSheetName(null);
    setPreviewLoading(false);
  }

  function renderCommentWithAttachments(content: string) {
    const usedNames = getAttachmentNamesFromText(content);
    const cleaned = content
      .replace(/\[attachment:\s*[^\]]+\]/gi, '')
      .replace(/(?:^|\n)\s*attachment:\s*[^\n]+/gi, '')
      .trim();
    return (
      <>
        {cleaned ? <p className="ticket-detail__comment-text">{cleaned}</p> : null}
        {Array.from(usedNames).map((name) => {
          const attachment = findAttachmentByName(attachments, name);
          if (!attachment) {
            return <p key={name} className="ticket-detail__comment-attachment-missing">Attachment not found: {name}</p>;
          }
          const isImage = attachment.contentType?.startsWith('image/');
          const badge = attachmentTypeBadge(attachment.contentType, attachment.originalFilename);
          return (
            <button
              key={`${name}-${attachment.id}`}
              type="button"
              className={`ticket-detail__comment-attachment ${isImage ? 'ticket-detail__comment-attachment--image' : ''}`}
              onClick={() => openAttachmentPreview(attachment)}
            >
              {isImage && attachmentPreviewUrls[attachment.id] ? (
                <img src={attachmentPreviewUrls[attachment.id]} alt={attachment.originalFilename} className="ticket-detail__comment-attachment-thumb ticket-detail__comment-attachment-thumb--comment" />
              ) : (
                <span
                  className={`ticket-detail__comment-attachment-file ticket-detail__comment-attachment-file--${badge.kind}`}
                >
                  {badge.label}
                </span>
              )}
              <span>{attachment.originalFilename}</span>
            </button>
          );
        })}
      </>
    );
  }

  function getAttachmentNamesFromText(text: string) {
    const result = new Set<string>();
    const bracketMatches = [...text.matchAll(/\[attachment:\s*([^\]]+)\]/gi)];
    bracketMatches.forEach((m) => result.add(m[1].trim()));
    const plainMatches = [...text.matchAll(/(?:^|\n)\s*attachment:\s*([^\n]+)/gi)];
    plainMatches.forEach((m) => result.add(m[1].trim()));
    return result;
  }

  function getAttachmentNamesFromHtml(html: string) {
    const result = new Set<string>();
    if (!/<\/?[a-z][\s\S]*>/i.test(html)) return result;
    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('[data-attachment-name], [data-attachment-id]').forEach((el) => {
      const idAttr = el.getAttribute('data-attachment-id');
      const nameAttr = el.getAttribute('data-attachment-name');
      const attachment = findAttachmentById(attachments, idAttr) ?? (nameAttr ? findAttachmentByName(attachments, nameAttr) : undefined);
      if (attachment?.originalFilename) result.add(attachment.originalFilename);
      else if (nameAttr) result.add(nameAttr.trim());
    });
    return result;
  }

  function renderInlineAttachmentPreviews(text: string) {
    const names = text.includes('[attachment:') || /(?:^|\n)\s*attachment:/i.test(text)
      ? getAttachmentNamesFromText(text)
      : new Set(text.split('\n').map((s) => s.trim()).filter(Boolean));
    if (names.size === 0) return null;
    return (
      <div className="ticket-detail__comment-inline-attachments">
        {Array.from(names).map((name) => {
          const attachment = findAttachmentByName(attachments, name);
          if (!attachment) return null;
          const isImage = attachment.contentType?.startsWith('image/');
          const badge = attachmentTypeBadge(attachment.contentType, attachment.originalFilename);
          return (
            <button
              key={`inline-${attachment.id}`}
              type="button"
              className={`ticket-detail__comment-attachment ticket-detail__comment-attachment--inline ${isImage ? 'ticket-detail__comment-attachment--image' : ''}`}
              onClick={() => openAttachmentPreview(attachment)}
            >
              {isImage && attachmentPreviewUrls[attachment.id] ? (
                <img src={attachmentPreviewUrls[attachment.id]} alt={attachment.originalFilename} className="ticket-detail__comment-attachment-thumb ticket-detail__comment-attachment-thumb--large" />
              ) : (
                <span
                  className={`ticket-detail__comment-attachment-file ticket-detail__comment-attachment-file--large ticket-detail__comment-attachment-file--${badge.kind}`}
                >
                  {badge.label}
                </span>
              )}
              <span>{attachment.originalFilename}</span>
            </button>
          );
        })}
      </div>
    );
  }

  async function handleDeleteAttachment(attachmentId: number) {
    if (!ticket.dbId) return;
    try {
      await attachmentApi.delete(ticket.dbId, attachmentId);
      setAttachments((prev) => (prev ?? []).filter((a) => a.id !== attachmentId));
    } catch {
      alert('Failed to delete attachment');
    }
  }

  function selectLinkCandidate(candidate: Ticket) {
    setLinkTarget(candidate.id);
    setLinkError(null);
    setLinkPickerOpen(false);
    setRecentLinkIssueKeys((prev) => {
      const next = [candidate.id, ...prev.filter((x) => x !== candidate.id)].slice(0, 20);
      try {
        localStorage.setItem(LINK_RECENT_KEYS_STORAGE, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function getEditorRefForTarget(target: EditorAttachTarget): React.RefObject<HTMLDivElement | null> | null {
    if (target === 'description') return descriptionEditorRef;
    if (target === 'comment') return commentEditorRef;
    if (target === 'comment-edit') return editingCommentEditorRef;
    return null;
  }

  function focusEditor(target: EditorAttachTarget) {
    const ref = getEditorRefForTarget(target);
    ref?.current?.focus();
  }

  function syncEditorState(target: EditorAttachTarget) {
    const ref = getEditorRefForTarget(target);
    if (!ref?.current) return;
    const html = ref.current.innerHTML;
    if (target === 'comment') setCommentHtml(html);
    else if (target === 'comment-edit') setEditingCommentText(html);
  }

  function execEditorCommand(target: EditorAttachTarget, command: string, value?: string) {
    focusEditor(target);
    document.execCommand(command, false, value);
    syncEditorState(target);
  }

  function applyHeading(target: EditorAttachTarget) {
    focusEditor(target);
    const ref = getEditorRefForTarget(target);
    if (!ref?.current) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    let parent: HTMLElement | null = node && node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : (node?.parentElement ?? null);
    while (parent && parent !== ref.current && !/^(H1|H2|H3|H4|P|DIV)$/.test(parent.tagName)) {
      parent = parent.parentElement;
    }
    const currentTag = parent?.tagName;
    const nextTag = currentTag === 'H2' ? 'H3' : currentTag === 'H3' ? 'P' : 'H2';
    document.execCommand('formatBlock', false, nextTag);
    syncEditorState(target);
  }

  function insertLink(target: EditorAttachTarget) {
    focusEditor(target);
    const sel = document.getSelection();
    const selectedText = sel?.toString() ?? '';
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    setLinkDialog({
      target,
      displayText: selectedText,
      url: 'https://',
      savedRange,
      initialHadSelection: selectedText.length > 0,
    });
    setTimeout(() => {
      // If text was pre-filled from a selection, focus URL field; otherwise focus text field.
      (selectedText ? linkUrlInputRef.current : linkTextInputRef.current)?.focus();
      (selectedText ? linkUrlInputRef.current : linkTextInputRef.current)?.select();
    }, 0);
  }

  function confirmLinkDialog() {
    if (!linkDialog) return;
    const { target, displayText, url, savedRange, initialHadSelection } = linkDialog;
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    const finalText = displayText.trim() || trimmedUrl;
    const safeUrl = /^[a-z]+:|^\/|^#/i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
    const editorRef = getEditorRefForTarget(target);
    const editor = editorRef?.current;
    if (!editor) {
      setLinkDialog(null);
      return;
    }
    editor.focus();
    if (savedRange) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRange);
    }
    if (initialHadSelection && finalText === displayText.trim()) {
      // User had pre-selected text; just wrap it with createLink
      document.execCommand('createLink', false, safeUrl);
      // Patch any anchors created from the selection so they open in a new tab
      const newAnchors = editor.querySelectorAll('a[href]:not([data-link-finalized])');
      newAnchors.forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('data-link-finalized', 'true');
      });
    } else {
      // No selection or display text changed; insert a fresh anchor
      const html = `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" data-link-finalized="true">${escapeHtml(finalText)}</a>`;
      document.execCommand('insertHTML', false, html);
    }
    syncEditorState(target);
    setLinkDialog(null);
  }

  function cancelLinkDialog() {
    setLinkDialog(null);
  }

  function insertCodeBlock(target: EditorAttachTarget) {
    focusEditor(target);
    const sel = document.getSelection();
    const text = sel?.toString();
    if (text) {
      document.execCommand('insertHTML', false, `<pre class="ticket-rich-code"><code>${escapeHtml(text)}</code></pre>`);
    } else {
      document.execCommand('insertHTML', false, '<pre class="ticket-rich-code"><code>code</code></pre>');
    }
    syncEditorState(target);
  }

  const EDITOR_EMOJIS = [
    '😀', '😄', '😅', '😂', '🙂', '😉', '😍', '🤔',
    '👍', '👎', '👏', '🙏', '💪', '🤝', '👀', '🫡',
    '🎉', '🔥', '✅', '❌', '⚠️', '❓', '💡', '🚀',
    '🐛', '🔧', '📌', '📝', '⏰', '💯', '❤️', '😢',
  ];

  /** Full "clear formatting": inline styles + links + heading/blockquote back to plain paragraph. */
  function clearFormatting(target: EditorAttachTarget) {
    focusEditor(target);
    document.execCommand('removeFormat');
    document.execCommand('unlink');
    document.execCommand('formatBlock', false, 'P');
    syncEditorState(target);
  }

  function insertEmoji(target: EditorAttachTarget, emoji: string) {
    focusEditor(target);
    document.execCommand('insertText', false, emoji);
    syncEditorState(target);
    setEmojiPickerFor(null);
  }

  function renderEditorToolbar(target: EditorAttachTarget) {
    const noFocusLoss = (e: React.MouseEvent) => e.preventDefault();
    const isCommentComposer = target === 'comment';
    return (
      <div className="ticket-editor__toolbar" onMouseDown={noFocusLoss}>
        <button type="button" className="ticket-editor__tool" title="Heading" onClick={() => applyHeading(target)}>Tt</button>
        <span className="ticket-editor__sep" />
        <button type="button" className="ticket-editor__tool" title="Bold (Cmd+B)" onClick={() => execEditorCommand(target, 'bold')}><strong>B</strong></button>
        <button type="button" className="ticket-editor__tool" title="Italic (Cmd+I)" onClick={() => execEditorCommand(target, 'italic')}><em>I</em></button>
        <button type="button" className="ticket-editor__tool" title="Underline" onClick={() => execEditorCommand(target, 'underline')}><u>U</u></button>
        <span className="ticket-editor__sep" />
        <button type="button" className="ticket-editor__tool" title="Strikethrough" onClick={() => execEditorCommand(target, 'strikeThrough')}><s>S</s></button>
        <span className="ticket-editor__sep" />
        <button type="button" className="ticket-editor__tool" title="Bulleted list" onClick={() => execEditorCommand(target, 'insertUnorderedList')}>•</button>
        <button type="button" className="ticket-editor__tool" title="Numbered list" onClick={() => execEditorCommand(target, 'insertOrderedList')}>1.</button>
        <button type="button" className="ticket-editor__tool" title="Quote" onClick={() => execEditorCommand(target, 'formatBlock', 'BLOCKQUOTE')}>❝</button>
        <button type="button" className="ticket-editor__tool" title="Insert link" onClick={() => insertLink(target)}>🔗</button>
        <button type="button" className="ticket-editor__tool ticket-editor__tool--attach" title="Add image, video, or file" onClick={() => openEditorAttachPicker(target)}>🖼</button>
        <span className="ticket-editor__emoji-wrap">
          <button
            type="button"
            className={`ticket-editor__tool${emojiPickerFor === target ? ' ticket-editor__tool--active' : ''}`}
            title="Emoji"
            aria-expanded={emojiPickerFor === target}
            onClick={() => setEmojiPickerFor((prev) => (prev === target ? null : target))}
          >
            ☺
          </button>
          {emojiPickerFor === target && (
            <div className="ticket-editor__emoji-pop" role="menu" aria-label="Pick an emoji">
              {EDITOR_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="ticket-editor__emoji-btn"
                  onClick={() => insertEmoji(target, emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </span>
        <button type="button" className="ticket-editor__tool" title="Code block" onClick={() => insertCodeBlock(target)}>&lt;/&gt;</button>
        <button type="button" className="ticket-editor__tool" title="Clear formatting" aria-label="Clear formatting" onClick={() => clearFormatting(target)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
            <path d="M22 21H7" />
            <path d="m5 11 9 9" />
          </svg>
        </button>
        {isCommentComposer ? (
          <button type="button" className="ticket-editor__tool" title="Close editor" aria-label="Close editor" onClick={handleCancelCommentEditor}>✕</button>
        ) : null}
      </div>
    );
  }

  function stripHtml(value: string) {
    return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(value: string) {
    return escapeCommentHtml(value);
  }

  function normalizeCommentHtml(html: string) {
    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('[data-attachment-name], [data-attachment-id], [data-pending-attachment-id]').forEach((el) => {
      el.removeAttribute('data-pending-attachment-id');
      if (el.tagName === 'IMG') {
        el.removeAttribute('src');
        el.classList.add('ticket-rich-image');
      }
    });
    // contenteditable serializes spaces as &nbsp;; store normal spaces so the
    // description stays human-readable in the editor and API.
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent) {
        node.textContent = node.textContent.replace(/\u00a0/g, ' ');
      } else {
        node.childNodes.forEach(walk);
      }
    };
    walk(container);
    return container.innerHTML.replace(/&nbsp;/gi, ' ').trim();
  }

  // Convert legacy `[attachment: filename]` tokens (or `attachment: filename` lines) into
  // proper inline <img>/<span> HTML so they render the same as new rich-editor uploads.
  function expandAttachmentTokensToHtml(text: string): string {
    const buildAttachmentHtml = (rawName: string): string => {
      const name = rawName.trim();
      const attachment = findAttachmentByName(attachments, name);
      if (!attachment) {
        return `<span data-attachment-name="${escapeHtml(name)}" data-attachment-missing="true">[file] ${escapeHtml(name)}</span>`;
      }
      const isImage = attachment.contentType?.startsWith('image/');
      const src = attachmentPreviewUrls[attachment.id] ?? '';
      const idAttr = `data-attachment-id="${attachment.id}"`;
      const nameAttr = `data-attachment-name="${escapeHtml(attachment.originalFilename)}"`;
      return isImage
        ? `<img ${idAttr} ${nameAttr} src="${escapeHtml(src)}" alt="${escapeHtml(attachment.originalFilename)}" />`
        : `<span ${idAttr} ${nameAttr}>[file] ${escapeHtml(attachment.originalFilename)}</span>`;
    };
    return text
      .split(/\r?\n/)
      .map((line) => {
        let processed = escapeHtml(line);
        // [attachment: name]
        processed = processed.replace(/\[attachment:\s*([^\]]+)\]/gi, (_m, n: string) => buildAttachmentHtml(n));
        // bare "attachment: name"
        processed = processed.replace(/^\s*attachment:\s*(.+)$/i, (_m, n: string) => buildAttachmentHtml(n));
        return `<p>${processed || '<br>'}</p>`;
      })
      .join('');
  }

  function hydrateCommentHtml(html: string) {
    const container = document.createElement('div');
    container.innerHTML = prepareCommentHtmlForDisplay(html);
    container.querySelectorAll('[data-attachment-name], [data-attachment-id]').forEach((el) => {
      const idAttr = el.getAttribute('data-attachment-id');
      const nameAttr = el.getAttribute('data-attachment-name');
      const attachment = findAttachmentById(attachments, idAttr) ?? (nameAttr ? findAttachmentByName(attachments, nameAttr) : undefined);
      if (!attachment) {
        if (el.tagName === 'IMG') {
          el.setAttribute('data-attachment-missing', 'true');
          el.removeAttribute('src');
          el.setAttribute('alt', nameAttr || 'attachment missing');
        } else {
          el.setAttribute('data-attachment-missing', 'true');
        }
        return;
      }
      el.setAttribute('data-attachment-id', String(attachment.id));
      el.setAttribute('data-attachment-name', attachment.originalFilename);
      el.removeAttribute('data-attachment-missing');
      if (el.tagName === 'IMG') {
        const src = attachmentPreviewUrls[attachment.id];
        if (src) el.setAttribute('src', src);
        el.classList.add('ticket-rich-image');
      }
    });
    return container.innerHTML;
  }

  const statusColor = STATUS_COLORS[draft.status];
  const detailStatusOptions = draft.issueType === 'epic' ? EPIC_STATUS_OPTIONS : STATUS_OPTIONS;
  const epicDescendants = draft.issueType === 'epic'
    ? getDescendantKeys(draft.id, allTickets)
        .map((id) => allTickets.find((t) => t.id === id))
        .filter((t): t is Ticket => Boolean(t))
    : [];
  const completedEpicDescendants = epicDescendants.filter((t) => t.status === 'done').length;
  const allEpicChildrenDone = epicDescendants.length > 0 && completedEpicDescendants === epicDescendants.length;

  async function handleDetailStatusChange(status: TicketStatus) {
    if (statusSaveInProgress || status === draft.status) return;
    const previousStatus = draft.status;
    const updated: Ticket = { ...draft, status };
    setDraft(updated);
    setStatusSaveInProgress(true);
    try {
      const saved = await Promise.resolve(onUpdate(updated));
      if (saved === false) {
        setDraft((prev) => ({ ...prev, status: previousStatus }));
      }
    } finally {
      setStatusSaveInProgress(false);
    }
  }
  const subtasks = allTickets.filter((t) => t.parentId === draft.id);
  const parentTicket = draft.parentId ? allTickets.find((t) => t.id === draft.parentId) : null;
  return (
    <div
      className="ticket-detail-overlay"
      ref={overlayRef}
      onMouseDown={(e) => { if (e.target === overlayRef.current) handleClose(); }}
    >
      <div className="ticket-detail-modal">
        {/* Breadcrumb */}
        <nav className="td-breadcrumb td-breadcrumb--modal" aria-label="Breadcrumb">
          {canLinkEpic && (
            <div className="td-epic-picker">
              <button
                type="button"
                className={`td-epic-picker__trigger${selectedEpic ? ' td-epic-picker__trigger--has-epic' : ''}`}
                onClick={() => setEpicPickerOpen((v) => !v)}
              >
                {selectedEpic ? (
                  <>
                    <span className="td-epic-picker__rail" aria-hidden />
                    <span className="td-epic-picker__epic-ico" aria-hidden>{ISSUE_TYPE_META.epic.icon}</span>
                    <span className="td-epic-picker__epic-word">Epic</span>
                    <IssueKeyChip issueKey={selectedEpic.id} size="sm" variant="onEpic" />
                  </>
                ) : (
                  <>
                    <span aria-hidden>✎</span>
                    <span>Add epic</span>
                  </>
                )}
              </button>
              {epicPickerOpen && (
                <div className="td-epic-picker__popover">
                  <select
                    className="td-epic-picker__select"
                    value={draft.parentId ?? ''}
                    onChange={(e) => {
                      patch('parentId', e.target.value || undefined);
                      setEpicPickerOpen(false);
                    }}
                  >
                    <option value="">No epic</option>
                    {epicOptions.map((epic) => (
                      <option key={epic.id} value={epic.id}>
                        {epic.id} - {epic.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          {inheritedEpicOnly && selectedEpic && (
            <div className="td-epic-picker">
              <button
                type="button"
                className="td-epic-picker__trigger td-epic-picker__trigger--has-epic td-epic-picker__trigger--inherited"
                title={`Inherited from parent — Epic ${selectedEpic.id}`}
                onClick={() => {
                  handleClose();
                  onOpenTicket(selectedEpic.id);
                }}
              >
                <span className="td-epic-picker__rail" aria-hidden />
                <span className="td-epic-picker__epic-ico" aria-hidden>{ISSUE_TYPE_META.epic.icon}</span>
                <span className="td-epic-picker__epic-word">Epic</span>
                <IssueKeyChip issueKey={selectedEpic.id} size="sm" variant="onEpic" />
              </button>
            </div>
          )}
          <span className="td-breadcrumb__sep">/</span>
          <span className="td-breadcrumb__item td-breadcrumb__item--current">
            <IssueTypeIcon type={draft.issueType} />
            <IssueKeyChip issueKey={draft.id} size="md" variant="default" className="td-breadcrumb__keychip" />
          </span>
        </nav>

        {/* Header: key + status + title stay pinned; only body scrolls */}
        <div className="ticket-detail__header">
          <div className="ticket-detail__header-left">
            <div className="ticket-detail__header-meta">
              <IssueKeyChip issueKey={draft.id} size="lg" variant="header" className="ticket-detail__id-chip" />
              <span
                className="ticket-detail__status-badge"
                style={{ background: statusColor + '22', color: statusColor, borderColor: statusColor + '55' }}
              >
                {detailStatusOptions.find((s) => s.value === draft.status)?.label}
              </span>
            </div>
            <div className="ticket-detail__header-title">
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  className="ticket-detail__title-input ticket-detail__title-input--header"
                  value={draft.title}
                  onChange={(e) => patch('title', e.target.value)}
                  onBlur={() => setEditingTitle(false)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setEditingTitle(false); }}
                />
              ) : (
                <h1
                  className="ticket-detail__title ticket-detail__title--header"
                  onClick={() => setEditingTitle(true)}
                  title={draft.title ? `${draft.title} (click to edit)` : 'Click to edit'}
                >
                  {draft.title || <span className="ticket-detail__placeholder">Add title…</span>}
                </h1>
              )}
            </div>
          </div>
          <div className="ticket-detail__header-actions">
            <div className="ticket-detail__ai-wrapper" ref={aiMenuRef}>
              <button
                type="button"
                className={`ticket-detail__ai-trigger ${aiMenuOpen ? 'ticket-detail__ai-trigger--open' : ''}`}
                onClick={() => setAiMenuOpen((v) => !v)}
                aria-expanded={aiMenuOpen}
                aria-haspopup="menu"
              >
                <span className="ticket-detail__ai-icon" aria-hidden>✦</span>
                Improve Story
              </button>
              {aiMenuOpen && (
                <div className="ticket-detail__ai-menu" role="menu">
                  <div className="ticket-detail__ai-menu__header">ATLASSIAN INTELLIGENCE</div>
                  {[
                    { id: 'improve-description', icon: '✎', label: 'Improve description' },
                    { id: 'summarize-comments', icon: '☰', label: 'Summarize comments' },
                    { id: 'suggest-children', icon: '⌥', label: 'Suggest child work items' },
                    { id: 'link-similar', icon: '⇄', label: 'Link similar work items' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="menuitem"
                      className="ticket-detail__ai-menu__item"
                      onClick={() => {
                        setAiMenuOpen(false);
                        alert(`AI: "${opt.label}" — coming soon. (Will call agentic AI backend.)`);
                      }}
                    >
                      <span className="ticket-detail__ai-menu__icon" aria-hidden>{opt.icon}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {onDeleteTicket && (
              <div className="ticket-detail__more-wrapper" ref={moreMenuRef}>
                <button
                  type="button"
                  className={`ticket-detail__more-trigger${moreMenuOpen ? ' ticket-detail__more-trigger--open' : ''}`}
                  aria-label="More actions"
                  title="More actions"
                  aria-expanded={moreMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setMoreMenuOpen((v) => !v)}
                >
                  ⋯
                </button>
                {moreMenuOpen && (
                  <div className="ticket-detail__more-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="ticket-detail__more-menu__item"
                      onClick={handleToggleFlag}
                    >
                      <span aria-hidden>{draft.flagged ? '⚐' : '⚑'}</span>
                      {draft.flagged ? 'Remove flag' : 'Add flag'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="ticket-detail__more-menu__item ticket-detail__more-menu__item--danger"
                      onClick={() => {
                        setMoreMenuOpen(false);
                        handleDeleteIssue();
                      }}
                    >
                      🗑 Delete issue
                    </button>
                  </div>
                )}
              </div>
            )}
            <button type="button" className="ticket-detail__close" aria-label="Close" onClick={handleClose}>✕</button>
          </div>
        </div>

        {/* Body */}
        <div className="ticket-detail__body">
          {/* Left panel */}
          <div className="ticket-detail__left">
            {/* Description */}
            <div className="ticket-detail__section">
              <h3 className="ticket-detail__section-title">Description</h3>
              {editingDesc ? (
                <div className="ticket-detail__desc-editor">
                  {renderEditorToolbar('description')}
                  <div
                    ref={descriptionEditorRef}
                    className="ticket-detail__comment-rich-editor ticket-detail__desc-rich-editor"
                    contentEditable
                    suppressContentEditableWarning
                    data-placeholder="Add a description…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void handleSaveDescription();
                      }
                    }}
                  />
                  <div className="ticket-detail__desc-actions">
                    <button
                      type="button"
                      className="ticket-detail__btn ticket-detail__btn--primary"
                      onClick={() => { void handleSaveDescription(); }}
                      disabled={descSaveInProgress}
                    >
                      {descSaveInProgress ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="ticket-detail__btn ticket-detail__btn--ghost"
                      onClick={handleCancelDescriptionEdit}
                      disabled={descSaveInProgress}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className={`ticket-detail__desc-view ${!draft.description ? 'ticket-detail__desc-view--empty' : ''} ticket-detail__comment-rich-content`}
                  onClick={(e) => {
                    const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
                    const attachmentEl = (e.target as HTMLElement).closest('[data-attachment-id],[data-attachment-name]') as HTMLElement | null;
                    if (anchor || attachmentEl) {
                      handleCommentAttachmentClick(e);
                      return;
                    }
                    setEditingDesc(true);
                  }}
                >
                  {draft.description ? (
                    containsHtmlMarkup(draft.description) ? (
                      <span dangerouslySetInnerHTML={{ __html: hydrateCommentHtml(draft.description) }} />
                    ) : (/\[attachment:/i.test(draft.description) || /^\s*attachment:/im.test(draft.description)) ? (
                      <span dangerouslySetInnerHTML={{ __html: expandAttachmentTokensToHtml(draft.description) }} />
                    ) : (
                      draft.description
                    )
                  ) : (
                    'Add a description…'
                  )}
                </div>
              )}
            </div>

            <div className="ticket-detail__section">
              <h3 className="ticket-detail__section-title">
                Attachments <span className="ticket-detail__attachment-count">{panelAttachments.length}</span>
              </h3>
              <div className="ticket-detail__attachment-actions">
                <button
                  type="button"
                  className="ticket-detail__btn ticket-detail__btn--ghost"
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  + Add attachment
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  className="ticket-detail__attachment-input"
                  onChange={(e) => handleSelectAttachmentFiles(e.target.files)}
                />
              </div>
              <div className="ticket-detail__attachment-list">
                {panelAttachments.length === 0 && (
                  <p className="ticket-detail__no-comments">No attachments yet.</p>
                )}
                {panelAttachments.map((a) => {
                  const badge = attachmentTypeBadge(a.contentType, a.originalFilename);
                  return (
                  <div key={a.id} className="ticket-detail__attachment-item">
                    <button
                      type="button"
                      className="ticket-detail__attachment-file"
                      onClick={() => openAttachmentPreview(a)}
                    >
                      {attachmentPreviewUrls[a.id] ? (
                        <img className="ticket-detail__attachment-thumb" src={attachmentPreviewUrls[a.id]} alt={a.originalFilename} />
                      ) : (
                        <span
                          className={`ticket-detail__attachment-thumb ticket-detail__attachment-thumb--placeholder ticket-detail__attachment-thumb--placeholder--${badge.kind}`}
                        >
                          {badge.label}
                        </span>
                      )}
                      <span className="ticket-detail__attachment-name">{a.originalFilename}</span>
                      <span className="ticket-detail__attachment-meta">
                        {a.uploaderName ?? 'Unknown'} · {formatSize(a.sizeBytes)} · {formatTs(a.createdAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ticket-detail__comment-action ticket-detail__comment-action--delete"
                      onClick={() => handleDeleteAttachment(a.id)}
                    >
                      ✕
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>

            {/* Subtasks / Child Issues */}
            <div className="ticket-detail__section">
              <h3 className="ticket-detail__section-title">Child Issues</h3>
              <div className="ticket-detail__subtasks">
                {subtasks.map((sub) => {
                  const meta = sub.issueType ? ISSUE_TYPE_META[sub.issueType] : undefined;
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      className="ticket-detail__subtask-item"
                      onClick={() => { handleClose(); onOpenTicket(sub.id); }}
                    >
                      {meta && <span className="ticket-detail__subtask-type-icon" style={{ color: meta.color }}>{meta.icon}</span>}
                      <span
                        className="ticket-detail__subtask-status"
                        style={{ background: STATUS_COLORS[sub.status] }}
                        title={sub.status}
                      />
                      <span className="ticket-detail__subtask-id">{sub.id}</span>
                      <span className="ticket-detail__subtask-title">{sub.title}</span>
                    </button>
                  );
                })}

                {draft.issueType === 'epic' ? (
                  <p className="ticket-detail__field-hint" style={{ marginTop: 8 }}>
                    Epics do not use subtasks in Jira. Create stories or tasks and link them with <strong>Add epic</strong> on each issue, or set the epic in the backlog.
                  </p>
                ) : addingSubtask ? (
                  <div className="ticket-detail__subtask-create">
                    <input
                      ref={subtaskInputRef}
                      className="ticket-detail__subtask-input"
                      placeholder="Child issue title…"
                      value={subtaskTitle}
                      onChange={(e) => setSubtaskTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleCreateSubtask();
                        if (e.key === 'Escape') { setAddingSubtask(false); setSubtaskTitle(''); }
                      }}
                    />
                    <div className="ticket-detail__subtask-actions">
                      <button
                        type="button"
                        className="ticket-detail__btn ticket-detail__btn--primary"
                        onClick={() => void handleCreateSubtask()}
                        disabled={!subtaskTitle.trim()}
                        title={!subtaskTitle.trim() ? 'Enter a title first' : undefined}
                      >
                        Create
                      </button>
                      <button type="button" className="ticket-detail__btn ticket-detail__btn--ghost" onClick={() => { setAddingSubtask(false); setSubtaskTitle(''); }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="ticket-detail__add-subtask" onClick={() => setAddingSubtask(true)}>
                    + Create child issue
                  </button>
                )}
              </div>
            </div>

            {/* Activity / Comments */}
            <div className="ticket-detail__section">
              <h3 className="ticket-detail__section-title">Linked work items</h3>
              <div className="ticket-detail__link-create" ref={linkPickerRef}>
                <select className="ticket-detail__select" value={linkRelation} onChange={(e) => setLinkRelation(e.target.value as (typeof LINK_RELATION_OPTIONS)[number])}>
                  {LINK_RELATION_OPTIONS.map((relation) => (
                    <option key={relation} value={relation}>{relation}</option>
                  ))}
                </select>
                <div className="ticket-detail__link-search-wrap">
                  <input
                    className="ticket-detail__input"
                    type="text"
                    placeholder="Type, search or paste issue key"
                    value={linkTarget}
                    onFocus={() => setLinkPickerOpen(true)}
                    onKeyDown={(e) => {
                      if (!linkPickerOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                        setLinkPickerOpen(true);
                        return;
                      }
                      if (!pickerItems.length) return;
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setLinkHighlightIndex((idx) => (idx + 1) % pickerItems.length);
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setLinkHighlightIndex((idx) => (idx - 1 + pickerItems.length) % pickerItems.length);
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        const candidate = pickerItems[linkHighlightIndex];
                        if (candidate) selectLinkCandidate(candidate);
                      } else if (e.key === 'Escape') {
                        setLinkPickerOpen(false);
                      }
                    }}
                    onChange={(e) => {
                      setLinkTarget(e.target.value);
                      setLinkError(null);
                      setLinkPickerOpen(true);
                    }}
                  />
                  {linkPickerOpen && (
                    <div className="ticket-detail__link-search-dropdown">
                      {pickerItems.length === 0 ? (
                        <p className="ticket-detail__link-search-empty">No matching work items</p>
                      ) : (
                        <>
                          {showRecentSection && (
                            <>
                              <p className="ticket-detail__link-search-group">Recently viewed</p>
                              {recentLinkCandidates.map((candidate, idx) => {
                                const existing = existingRelationsByKey.get(candidate.id);
                                return (
                                  <button
                                    key={`recent-${candidate.id}`}
                                    type="button"
                                    className={`ticket-detail__link-search-item ${idx === linkHighlightIndex ? 'is-active' : ''}`}
                                    onMouseEnter={() => setLinkHighlightIndex(idx)}
                                    onClick={() => selectLinkCandidate(candidate)}
                                  >
                                    <span className="ticket-detail__link-search-icon" style={{ color: ISSUE_TYPE_META[candidate.issueType ?? 'task'].color }}>
                                      {ISSUE_TYPE_META[candidate.issueType ?? 'task'].icon}
                                    </span>
                                    <span className="ticket-detail__link-search-key">{candidate.id}</span>
                                    <span className="ticket-detail__link-search-title">{candidate.title}</span>
                                    {existing && existing.length > 0 && (
                                      <span className="ticket-detail__link-search-existing" title={`Already linked as ${existing.join(', ')}`}>
                                        linked as {existing.join(', ')}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </>
                          )}
                          {otherLinkCandidates.length > 0 && (
                            <>
                              <p className="ticket-detail__link-search-group">
                                {linkTarget.trim()
                                  ? `Matching work items (${otherLinkCandidates.length})`
                                  : showRecentSection
                                    ? 'All work items'
                                    : 'Work items'}
                              </p>
                              {otherLinkCandidates.map((candidate, localIdx) => {
                                const flatIdx = (showRecentSection ? recentLinkCandidates.length : 0) + localIdx;
                                const existing = existingRelationsByKey.get(candidate.id);
                                return (
                                  <button
                                    key={`all-${candidate.id}`}
                                    type="button"
                                    className={`ticket-detail__link-search-item ${flatIdx === linkHighlightIndex ? 'is-active' : ''}`}
                                    onMouseEnter={() => setLinkHighlightIndex(flatIdx)}
                                    onClick={() => selectLinkCandidate(candidate)}
                                  >
                                    <span className="ticket-detail__link-search-icon" style={{ color: ISSUE_TYPE_META[candidate.issueType ?? 'task'].color }}>
                                      {ISSUE_TYPE_META[candidate.issueType ?? 'task'].icon}
                                    </span>
                                    <span className="ticket-detail__link-search-key">{candidate.id}</span>
                                    <span className="ticket-detail__link-search-title">{candidate.title}</span>
                                    {existing && existing.length > 0 && (
                                      <span className="ticket-detail__link-search-existing" title={`Already linked as ${existing.join(', ')}`}>
                                        linked as {existing.join(', ')}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                <button type="button" className="ticket-detail__btn ticket-detail__btn--ghost" disabled={!linkTarget.trim()} onClick={addIssueLink}>Link</button>
              </div>
              {linkError && <p className="ticket-detail__code-error">{linkError}</p>}
              <div className="ticket-detail__linked-list">
                {(draft.linkedIssues ?? []).length === 0 && (
                  <p className="ticket-detail__no-comments">No linked work items.</p>
                )}
                {(draft.linkedIssues ?? []).map((l) => (
                  <div key={l.id} className="ticket-detail__linked-row">
                    <div className="ticket-detail__linked-main">
                      <span className="ticket-detail__linked-relation">{l.relation}</span>
                      <span className="ticket-detail__linked-arrow">→</span>
                      <a
                        className="ticket-detail__linked-link"
                        href={`/ticket/${l.linkedIssueKey}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${l.linkedIssueKey} in a new tab`}
                      >
                        <strong>{l.linkedIssueKey}</strong>
                        {l.linkedIssueTitle ? <span className="ticket-detail__linked-title"> {l.linkedIssueTitle}</span> : null}
                      </a>
                    </div>
                    {onDeleteIssueLink && (
                      <button
                        type="button"
                        className="ticket-detail__linked-remove"
                        onClick={() => removeIssueLink(l.id)}
                        title="Remove link"
                        aria-label="Remove link"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="ticket-detail__section">
              <h3 className="ticket-detail__section-title">Activity</h3>
              <div className="ticket-detail__activity-tabs">
                <button type="button" className={`ticket-detail__activity-tab ${activityTab === 'all' ? 'is-active' : ''}`} onClick={() => setActivityTab('all')}>All</button>
                <button type="button" className={`ticket-detail__activity-tab ${activityTab === 'comments' ? 'is-active' : ''}`} onClick={() => setActivityTab('comments')}>Comments</button>
                <button type="button" className={`ticket-detail__activity-tab ${activityTab === 'history' ? 'is-active' : ''}`} onClick={() => setActivityTab('history')}>History</button>
                <button type="button" className={`ticket-detail__activity-tab ${activityTab === 'worklog' ? 'is-active' : ''}`} onClick={() => setActivityTab('worklog')}>Work log</button>
              </div>
              {activityTab === 'comments' && (
                <>
              <div className="ticket-detail__comment-input-wrap">
                <div className="ticket-detail__avatar ticket-detail__avatar--you">Y</div>
                <div className="ticket-detail__comment-editor-wrap">
                  {!commentEditorOpen ? (
                    <button
                      type="button"
                      className="ticket-detail__comment-placeholder"
                      onClick={() => setCommentEditorOpen(true)}
                    >
                      Add a comment...
                    </button>
                  ) : (
                    <>
                      {renderEditorToolbar('comment')}
                      <div
                        ref={commentEditorRef}
                        className="ticket-detail__comment-rich-editor ticket-detail__comment-input--editor"
                        contentEditable
                        suppressContentEditableWarning
                        data-placeholder="Type / to add elements or @ to mention someone."
                        onInput={(e) => setCommentHtml((e.target as HTMLDivElement).innerHTML)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            handleAddComment();
                          }
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
              {(stripHtml(commentHtml).trim() || htmlHasAttachmentMarkers(commentHtml)) && (
                <div className="ticket-detail__comment-submit">
                  <button type="button" className="ticket-detail__btn ticket-detail__btn--primary" onClick={handleAddComment}>Save</button>
                  <button type="button" className="ticket-detail__btn ticket-detail__btn--ghost" onClick={handleCancelCommentEditor}>Cancel</button>
                </div>
              )}
                </>
              )}
              {activityTab === 'comments' && (
                <>
              <div className="ticket-detail__comments">
                {commentsForActivityList.length === 0 && (
                  <p className="ticket-detail__no-comments">No comments yet.</p>
                )}
                {commentsForActivityList.slice().reverse().map((c) => (
                  <div key={c.id} className="ticket-detail__comment">
                    <div className="ticket-detail__avatar">{c.author.charAt(0).toUpperCase()}</div>
                    <div className="ticket-detail__comment-body">
                      <div className="ticket-detail__comment-meta">
                        <span className="ticket-detail__comment-author">{c.author}</span>
                        <span className="ticket-detail__comment-time" title={formatTs(c.createdAt)}>
                          {formatRelativeTime(c.createdAt)}
                        </span>
                        {currentUserId != null && c.authorId === currentUserId && editingCommentId !== c.id && (
                          <>
                            <button
                              type="button"
                              className="ticket-detail__comment-action"
                              title="Edit comment"
                              onClick={() => handleStartEditComment(c)}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="ticket-detail__comment-action ticket-detail__comment-action--delete"
                              title="Delete comment"
                              onClick={() => handleDeleteComment(c)}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                      {editingCommentId === c.id ? (
                        <div className="ticket-detail__comment-edit">
                          {renderEditorToolbar('comment-edit')}
                          <div
                            ref={editingCommentEditorRef}
                            className="ticket-detail__comment-rich-editor ticket-detail__comment-input--editor"
                            contentEditable
                            suppressContentEditableWarning
                            data-placeholder="Type / to add elements or @ to mention someone."
                            onInput={(e) => setEditingCommentText((e.target as HTMLDivElement).innerHTML)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                handleSaveEditComment();
                              }
                            }}
                          />
                          {renderInlineAttachmentPreviews(editingCommentAttachmentNames.join('\n'))}
                          <div className="ticket-detail__comment-edit-actions">
                            <button
                              type="button"
                              className="ticket-detail__btn ticket-detail__btn--primary"
                              onClick={handleSaveEditComment}
                              disabled={!stripHtml(editingCommentText).trim() && !htmlHasAttachmentMarkers(editingCommentText)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="ticket-detail__btn ticket-detail__btn--ghost"
                              onClick={() => {
                                revokePendingMap(commentEditPendingRef.current);
                                setEditingCommentId(null);
                                setEditingCommentText('');
                                setEditingCommentAttachmentNames([]);
                                if (editingCommentEditorRef.current) editingCommentEditorRef.current.innerHTML = '';
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        (/<\/?[a-z][\s\S]*>/i.test(c.content)
                          ? <div
                              className="ticket-detail__comment-rich-content"
                              dangerouslySetInnerHTML={{ __html: hydrateCommentHtml(c.content) }}
                              onClick={handleCommentAttachmentClick}
                            />
                          : renderCommentWithAttachments(c.content))
                      )}
                    </div>
                  </div>
                ))}
              </div>
                </>
              )}
              {(activityTab === 'history' || activityTab === 'all') && (
                <div className="ticket-detail__history">
                  {displayedHistoryItems.length === 0 && <p className="ticket-detail__no-comments">No history yet.</p>}
                  {displayedHistoryItems.map((h) => {
                    const linkedComment = h.eventType === 'comment_created'
                      ? commentsByHistoryId.get(h.id)
                      : undefined;
                    return (
                    <div key={h.id} className="ticket-detail__history-row">
                      <div className="ticket-detail__avatar ticket-detail__avatar--history">
                        {actorInitials(h.actorName)}
                      </div>
                      <div className="ticket-detail__history-content">
                        <p className="ticket-detail__history-title">{renderHistoryTitle(h)}</p>
                        <div className="ticket-detail__history-meta">
                          <span className="ticket-detail__history-time" title={formatTs(h.createdAt)}>{formatRelativeTime(h.createdAt)}</span>
                          {h.fromValue != null || h.toValue != null ? (
                            <p className="ticket-detail__history-change">
                              <span className="ticket-detail__history-value">{formatHistoryStoredValue(h.fieldName, h.fromValue)}</span>
                              <span className="ticket-detail__history-arrow">→</span>
                              <span className="ticket-detail__history-value">{formatHistoryStoredValue(h.fieldName, h.toValue)}</span>
                            </p>
                          ) : null}
                        </div>
                        {linkedComment ? (
                          /<\/?[a-z][\s\S]*>/i.test(linkedComment.content)
                            ? <div
                                className="ticket-detail__history-comment ticket-detail__comment-rich-content"
                                dangerouslySetInnerHTML={{ __html: hydrateCommentHtml(linkedComment.content) }}
                                onClick={handleCommentAttachmentClick}
                              />
                            : <div className="ticket-detail__history-comment">
                                {renderCommentWithAttachments(linkedComment.content)}
                              </div>
                        ) : null}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
              {(activityTab === 'worklog' || activityTab === 'all') && (
                <div className="ticket-detail__worklog">
                  <div className="ticket-detail__lifecycle">
                    <h4 className="ticket-detail__lifecycle-title">Status lifecycle</h4>
                    <p className="ticket-detail__lifecycle-hint">
                      Time in each stage is derived from this issue&apos;s creation time and status changes in History.
                    </p>
                    {!ticket.createdAt && (
                      <p className="ticket-detail__lifecycle-empty">Creation time not loaded — refresh the page or reopen the issue.</p>
                    )}
                    {ticket.createdAt && statusLifecycleSegments.length > 0 && (
                      <div
                        className="ticket-detail__lifecycle-bar-wrap"
                        role="group"
                        aria-label={
                          lifecycleBarUseScrollZoom
                            ? 'Status timeline: segment widths are proportional to time; scroll horizontally to see the full bar'
                            : 'Status timeline: segment width is proportional to time in that status'
                        }
                      >
                        <div className="ticket-detail__lifecycle-scale">
                          <label className="ticket-detail__lifecycle-scale-label" htmlFor={`lifecycle-bar-zoom-${ticket.id}`}>
                            Zoom
                          </label>
                          <div className="ticket-detail__lifecycle-scale-row">
                            <span className="ticket-detail__lifecycle-scale-end">Fit width</span>
                            <input
                              id={`lifecycle-bar-zoom-${ticket.id}`}
                              className="ticket-detail__lifecycle-scale-range"
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              value={lifecycleBarZoom}
                              onChange={(e) => setLifecycleBarZoom(Number(e.target.value))}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={lifecycleBarZoom}
                              aria-valuetext={
                                lifecycleBarZoom === 0
                                  ? 'Timeline fits panel; proportions match duration'
                                  : `Magnified ${lifecycleBarZoom}%; scroll horizontally; proportions still match duration`
                              }
                            />
                            <span className="ticket-detail__lifecycle-scale-end">Magnify (scroll)</span>
                          </div>
                        </div>
                        <div
                          ref={lifecycleBarScrollRef}
                          className={`ticket-detail__lifecycle-bar-scroll${lifecycleBarUseScrollZoom ? ' ticket-detail__lifecycle-bar-scroll--active' : ''}`}
                        >
                          <div
                            className="ticket-detail__lifecycle-bar-inner"
                            style={
                              lifecycleBarUseScrollZoom
                                ? { width: `${lifecycleTrackWidthPx}px` }
                                : { width: '100%' }
                            }
                          >
                            <div
                              className={`ticket-detail__lifecycle-bar-track${lifecycleBarUseScrollZoom ? ' ticket-detail__lifecycle-bar-track--scroll' : ''}`}
                              onMouseLeave={() => setLifecycleBarTip(null)}
                            >
                              {lifecycleBarSegments.length === 0 ? (
                                (() => {
                                  const doneSeg = statusLifecycleSegments[statusLifecycleSegments.length - 1];
                                  return (
                                    <div
                                      key="lifecycle-bar-terminal-done"
                                      className={`ticket-detail__lifecycle-bar-seg ticket-detail__lifecycle-bar-seg--terminal-done${lifecycleBarUseScrollZoom ? ' ticket-detail__lifecycle-bar-seg--pct' : ''}`}
                                      style={{
                                        ...(lifecycleBarUseScrollZoom
                                          ? { flex: '0 0 auto', width: '100%' }
                                          : { flexGrow: 1 }),
                                        background: statusLifecycleSegmentColor('done'),
                                      }}
                                      onMouseEnter={(e) => {
                                        if (doneSeg) setLifecycleBarTip({ seg: doneSeg, x: e.clientX, y: e.clientY });
                                      }}
                                      onMouseMove={(e) => {
                                        if (doneSeg) setLifecycleBarTip({ seg: doneSeg, x: e.clientX, y: e.clientY });
                                      }}
                                    />
                                  );
                                })()
                              ) : (
                                lifecycleBarSegments.map((seg, idx) => (
                                  <div
                                    key={`lifecycle-bar-${seg.startedAtIso}-${idx}`}
                                    className={`ticket-detail__lifecycle-bar-seg${seg.isOngoing ? ' ticket-detail__lifecycle-bar-seg--ongoing' : ''}${lifecycleBarUseScrollZoom ? ' ticket-detail__lifecycle-bar-seg--pct' : ''}`}
                                    style={{
                                      ...(lifecycleBarUseScrollZoom
                                        ? {
                                            flex: '0 0 auto',
                                            width:
                                              lifecycleTotalMs > 0
                                                ? `${(Math.max(0, seg.durationMs) / lifecycleTotalMs) * 100}%`
                                                : '0%',
                                          }
                                        : { flexGrow: Math.max(seg.durationMs, 1) }),
                                      background: statusLifecycleSegmentColor(seg.status),
                                    }}
                                    onMouseEnter={(e) => {
                                      setLifecycleBarTip({ seg, x: e.clientX, y: e.clientY });
                                    }}
                                    onMouseMove={(e) => {
                                      setLifecycleBarTip({ seg, x: e.clientX, y: e.clientY });
                                    }}
                                  />
                                ))
                              )}
                            </div>
                            <div className="ticket-detail__lifecycle-bar-axis" aria-hidden>
                              <span>{formatLifecycleDate(statusLifecycleSegments[0].startedAtIso)}</span>
                              <span>
                                {(() => {
                                  const last = statusLifecycleSegments[statusLifecycleSegments.length - 1];
                                  if (last?.endedAtIso != null) return formatLifecycleDate(last.endedAtIso);
                                  return 'Now';
                                })()}
                              </span>
                            </div>
                          </div>
                        </div>
                        <p className="ticket-detail__lifecycle-bar-hint">
                          {lifecycleBarUseScrollZoom
                            ? 'Proportions always match real time. Drag the bar area horizontally to scroll when zoomed.'
                            : 'Bar width matches time in each stage. Increase zoom to widen the timeline and use the horizontal scrollbar to inspect short stages.'}
                        </p>
                      </div>
                    )}
                    {[...statusLifecycleSegments].reverse().map((seg, idx) => (
                      <div key={`${seg.startedAtIso}-${idx}`} className="ticket-detail__lifecycle-seg">
                        <div className="ticket-detail__lifecycle-seg-head">
                          <span className="ticket-detail__lifecycle-seg-status">{seg.statusLabel}</span>
                          <span className="ticket-detail__lifecycle-seg-dur">
                            {isInstantTerminalDone(seg) ? '—' : formatDurationMs(seg.durationMs)}
                          </span>
                          {seg.isOngoing && (
                            <span className="ticket-detail__lifecycle-seg-badge">
                              {seg.status === 'done' ? 'Completed (current)' : 'Current'}
                            </span>
                          )}
                        </div>
                        <div className="ticket-detail__lifecycle-seg-range">
                          {isInstantTerminalDone(seg) ? (
                            <>Completed {formatLifecycleDate(seg.endedAtIso ?? seg.startedAtIso)}</>
                          ) : (
                            <>
                              {formatLifecycleDate(seg.startedAtIso)}
                              {seg.endedAtIso ? (
                                <> → {formatLifecycleDate(seg.endedAtIso)}</>
                              ) : (
                                <> → …</>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                    {statusTransitionsNewestFirst.length > 0 && (
                      <>
                        <h5 className="ticket-detail__lifecycle-sub">Status changes (newest first)</h5>
                        <ul className="ticket-detail__lifecycle-events">
                          {statusTransitionsNewestFirst.map((h) => (
                            <li key={h.id}>
                              <span className="ticket-detail__lifecycle-ev-when">{formatLifecycleDate(h.createdAt)}</span>
                              {' — '}
                              <strong>{formatStatusLabel(h.fromValue)}</strong>
                              {' → '}
                              <strong>{formatStatusLabel(h.toValue)}</strong>
                              {h.actorName ? <span className="ticket-detail__lifecycle-ev-who"> · {h.actorName}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right panel: one scroll for Details + Development (no nested tiny viewport) */}
          <aside className="ticket-detail__right">
            <h3 className="ticket-detail__section-title">Details</h3>

            <DetailRow label="Priority">
              <select
                className="ticket-detail__select ticket-detail__priority-select"
                value={draft.priority ?? ''}
                onChange={(e) => patch('priority', (e.target.value as TicketPriority) || undefined)}
                style={draft.priority ? { color: PRIORITY_META[draft.priority].color, fontWeight: 600 } : {}}
              >
                <option value="">No priority</option>
                {ALL_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_META[p].icon} {PRIORITY_META[p].label}
                  </option>
                ))}
              </select>
            </DetailRow>

            <DetailRow label="Status">
              <div className="ticket-detail__epic-status-wrap">
                {draft.issueType === 'epic' ? (
                  <div>
                    <span
                      className="ticket-detail__epic-derived-status"
                      style={{ color: statusColor, borderColor: `${statusColor}55`, background: `${statusColor}12` }}
                    >
                      {detailStatusOptions.find((option) => option.value === draft.status)?.label}
                    </span>
                    <p className="ticket-detail__field-hint">Automatically derived from child work item stages.</p>
                  </div>
                ) : (
                  <select
                    className="ticket-detail__select"
                    value={draft.status}
                    onChange={(e) => { void handleDetailStatusChange(e.target.value as TicketStatus); }}
                    disabled={statusSaveInProgress}
                    aria-busy={statusSaveInProgress}
                    style={{ color: statusColor, fontWeight: 600 }}
                  >
                    {detailStatusOptions.map(({ value, label }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                )}
                {draft.issueType === 'epic' && epicDescendants.length > 0 && (
                  <div className={`ticket-detail__epic-progress${allEpicChildrenDone ? ' is-complete' : ''}`}>
                    <span>{completedEpicDescendants}/{epicDescendants.length} child work items Done</span>
                  </div>
                )}
              </div>
            </DetailRow>

            <DetailRow label="Issue type">
              <div>
                {draft.issueType === 'epic' ? (
                  <>
                    <span
                      className="ticket-detail__select"
                      style={{ color: ISSUE_TYPE_META.epic.color, fontWeight: 600, display: 'inline-block' }}
                    >
                      {ISSUE_TYPE_META.epic.icon} {ISSUE_TYPE_META.epic.label}
                    </span>
                    <p className="ticket-detail__field-hint">
                      Epics keep their type (same as Jira) — stories and tasks may already be linked to this epic.
                    </p>
                  </>
                ) : draft.issueType === 'subtask' ? (
                  <>
                    <span
                      className="ticket-detail__select"
                      style={{ color: ISSUE_TYPE_META.subtask.color, fontWeight: 600, display: 'inline-block' }}
                    >
                      {ISSUE_TYPE_META.subtask.icon} {ISSUE_TYPE_META.subtask.label}
                    </span>
                    <p className="ticket-detail__field-hint">
                      Subtasks keep their type — once created as a subtask, the issue type cannot be changed.
                    </p>
                  </>
                ) : (
                <select
                  className="ticket-detail__select"
                  value={draft.issueType ?? 'task'}
                  onChange={(e) => {
                    const next = e.target.value as IssueType;
                    setDraft((prev) => {
                      const nextDraft: Ticket = { ...prev, issueType: next };
                      nextDraft.labels = labelsForIssueType(next, prev.labels);
                      return nextDraft;
                    });
                  }}
                  style={{
                    color: ISSUE_TYPE_META[draft.issueType ?? 'task'].color,
                    fontWeight: 600,
                  }}
                >
                  {ISSUE_TYPE_OPTIONS.filter((t) => t !== 'epic' && t !== 'subtask').map((t) => (
                    <option key={t} value={t}>
                      {ISSUE_TYPE_META[t].icon} {ISSUE_TYPE_META[t].label}
                    </option>
                  ))}
                </select>
                )}
                {draft.issueType !== 'epic' && draft.issueType !== 'subtask' && (
                  <p className="ticket-detail__field-hint">
                    Subtasks must be created from a parent issue using Create child issue.
                  </p>
                )}
              </div>
            </DetailRow>

            <DetailRow label="Assignee">
              <select
                className="ticket-detail__select"
                value={draft.assignee ?? ''}
                onChange={(e) => setDraft((prev) => ({ ...prev, ...assigneeSelection(e.target.value || undefined) }))}
              >
                <option value="">Unassigned</option>
                {assigneeOptions.map((u) => (
                  <option key={u.id} value={u.name}>{u.name}</option>
                ))}
              </select>
            </DetailRow>

            <DetailRow label="Reporter">
              <select
                className="ticket-detail__select"
                value={draft.reporter ?? ''}
                onChange={(e) => setDraft((prev) => ({ ...prev, ...reporterSelection(e.target.value || undefined) }))}
              >
                <option value="">None</option>
                {reporterOptions.map((u) => (
                  <option key={u.id} value={u.name}>{u.name}</option>
                ))}
              </select>
            </DetailRow>

            {parentTicket && parentTicket.issueType !== 'epic' && (
              <DetailRow label="Parent">
                <button
                  type="button"
                  className="ticket-detail__parent-link"
                  onClick={() => { handleClose(); onOpenTicket(parentTicket.id); }}
                  title={parentTicket.title}
                >
                  {parentTicket.issueType && ISSUE_TYPE_META[parentTicket.issueType] && (
                    <span style={{ color: ISSUE_TYPE_META[parentTicket.issueType].color, marginRight: 4 }}>
                      {ISSUE_TYPE_META[parentTicket.issueType].icon}
                    </span>
                  )}
                  <span style={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>{parentTicket.id}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{parentTicket.title}</span>
                </button>
              </DetailRow>
            )}

            <DetailRow label="Labels">
              <LabelSelect
                selected={labelsForIssueType(draft.issueType, draft.labels)}
                onChange={(v) => patch('labels', v.length ? v : undefined)}
              />
            </DetailRow>

            <DetailRow label="Sprint">
              {draft.issueType === 'epic' ? (
                <p className="ticket-detail__field-hint" style={{ margin: 0 }}>
                  Epics are not assigned to sprints (same as Jira Software). Plan <strong>stories and tasks</strong> linked to this epic into sprints from the backlog.
                </p>
              ) : sprints ? (
                <div>
                  <select
                    className="ticket-detail__select"
                    value={draft.sprintId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value || undefined;
                      if (
                        id
                        && draft.issueType !== 'subtask'
                        && !(draft.storyPoints != null && draft.storyPoints > 0)
                      ) {
                        window.alert('Add story points before assigning this issue to a sprint.');
                        return;
                      }
                      const name = sprints.find((s) => s.id === id)?.name;
                      setDraft((prev) => ({ ...prev, sprintId: id, sprint: name }));
                    }}
                  >
                    <option value="">No sprint</option>
                    {sprintAssignmentOptions.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <p className="ticket-detail__field-hint">
                    Only sprints that have been <strong>started</strong> appear here. Open Backlog to start a sprint first.
                  </p>
                </div>
              ) : (
                <input
                  className="ticket-detail__input"
                  type="text"
                  placeholder="No sprint"
                  value={draft.sprint ?? ''}
                  onChange={(e) => patch('sprint', e.target.value || undefined)}
                />
              )}
            </DetailRow>

            {requiresSprintEstimate(draft.issueType) && (
              <DetailRow label="Story Points">
                <input
                  className="ticket-detail__input"
                  type="number"
                  placeholder="—"
                  min={1}
                  value={draft.storyPoints ?? ''}
                  onChange={(e) => patch('storyPoints', e.target.value ? Number(e.target.value) : undefined)}
                />
              </DetailRow>
            )}

            <DetailRow label="Start Date">
              <input
                className="ticket-detail__input"
                type="date"
                value={toInputDate(draft.startDate)}
                onChange={(e) => patch('startDate', e.target.value || undefined)}
              />
            </DetailRow>

            <DetailRow label="Due Date">
              <div className="ticket-detail__date-field">
                <input
                  className="ticket-detail__input"
                  type="date"
                  value={toInputDate(draft.dueDate)}
                  onChange={(e) => patch('dueDate', e.target.value || undefined)}
                />
                {draft.dueDate && (
                  <p className="ticket-detail__field-hint ticket-detail__due-preview">
                    Due {formatDueDateWithTime(draft.dueDate)}
                  </p>
                )}
              </div>
            </DetailRow>

            <div className="ticket-detail__dev-aside">
              <h3 className="ticket-detail__dev-aside-title ticket-detail__section-title ticket-detail__section-title--with-action">
                <span>
                  Development <span className="ticket-detail__attachment-count">{(draft.codeLinks ?? []).filter((c) => c.kind !== 'commit').length}</span>
                </span>
                {onRefreshCodeLinks && (draft.codeLinks ?? []).some((c) => c.kind !== 'commit') && (
                  <button
                    type="button"
                    className="ticket-detail__code-refresh"
                    onClick={refreshCodeLinks}
                    disabled={codeLinkRefreshing}
                    title="Fetch the latest PR state from GitHub"
                  >
                    {codeLinkRefreshing ? 'Refreshing…' : '↻ Refresh'}
                  </button>
                )}
              </h3>
              <p className="ticket-detail__dev-aside-hint">
                Paste a GitHub repo or pull request URL.
              </p>
              {codeLinkRefreshMsg && <p className="ticket-detail__code-note">{codeLinkRefreshMsg}</p>}
              {onAddCodeLink && (
                <div className="ticket-detail__code-create ticket-detail__code-create--stacked">
                  <input
                    className="ticket-detail__input ticket-detail__code-input"
                    type="url"
                    placeholder="Paste GitHub PR or repo URL…"
                    value={codeLinkUrl}
                    onChange={(e) => setCodeLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCodeLink();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="ticket-detail__btn ticket-detail__btn--ghost"
                    disabled={!codeLinkUrl.trim() || codeLinkSubmitting}
                    onClick={addCodeLink}
                  >
                    {codeLinkSubmitting ? 'Linking…' : 'Link'}
                  </button>
                </div>
              )}
              {codeLinkError && <p className="ticket-detail__code-error">{codeLinkError}</p>}
              <div className="ticket-detail__code-list">
                {(draft.codeLinks ?? []).filter((c) => c.kind !== 'commit').length === 0 && (
                  <p className="ticket-detail__dev-empty">
                    No code linked yet. Paste a GitHub pull request or repository URL.
                  </p>
                )}
                {(draft.codeLinks ?? [])
                  .filter((c) => c.kind !== 'commit')
                  .map((c) => {
                  const canDelete = Boolean(onDeleteCodeLink);
                  return (
                    <CodeLinkRow
                      key={c.id}
                      link={c}
                      onDelete={canDelete ? () => removeCodeLink(c.id) : undefined}
                    />
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      </div>
      <input
        ref={editorAttachmentInputRef}
        type="file"
        multiple
        className="ticket-detail__attachment-input"
        onChange={(e) => handleEditorAttachFiles(e.target.files)}
      />
      {previewAttachment && (
        <div className="ticket-detail__preview-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeAttachmentPreview(); }}>
          <div className="ticket-detail__preview-modal">
            <div className="ticket-detail__preview-header">
              <strong>{previewAttachment.originalFilename}</strong>
              <div className="ticket-detail__preview-actions">
                <button type="button" className="ticket-detail__btn ticket-detail__btn--ghost" onClick={() => handleDownloadAttachment(previewAttachment.id, previewAttachment.originalFilename)}>Download</button>
                <button type="button" className="ticket-detail__close" onClick={closeAttachmentPreview}>✕</button>
              </div>
            </div>
            <div className={`ticket-detail__preview-body${previewText !== null || previewTable ? ' ticket-detail__preview-body--scroll' : ''}`}>
              {previewLoading ? <p>Loading preview...</p> : null}
              {!previewLoading && previewAttachment.contentType?.startsWith('image/') && (
                <img
                  className="ticket-detail__preview-image"
                  src={attachmentPreviewUrls[previewAttachment.id] ?? previewObjectUrl ?? ''}
                  alt={previewAttachment.originalFilename}
                />
              )}
              {!previewLoading && (previewAttachment.contentType?.includes('pdf') || previewAttachment.originalFilename.toLowerCase().endsWith('.pdf')) && (
                <iframe
                  className="ticket-detail__preview-pdf"
                  src={previewObjectUrl ?? ''}
                  title={previewAttachment.originalFilename}
                />
              )}
              {!previewLoading && previewText !== null && (
                <pre className="ticket-detail__preview-text">{previewText}</pre>
              )}
              {!previewLoading && previewTable && previewTable.length > 0 && (
                <div className="ticket-detail__preview-table-wrap">
                  {previewSheetName ? <p className="ticket-detail__preview-sheet-name">{previewSheetName}</p> : null}
                  <table className="ticket-detail__preview-table">
                    <thead>
                      <tr>
                        {previewTable[0].map((cell, columnIndex) => (
                          <th key={`head-${columnIndex}`}>{cell}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewTable.slice(1).map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`}>
                          {row.map((cell, columnIndex) => (
                            <td key={`cell-${rowIndex}-${columnIndex}`}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!previewLoading
                && getAttachmentPreviewKind(previewAttachment.contentType, previewAttachment.originalFilename) === 'unsupported'
                && (
                <p>Preview is not available for this file type. Click Download to open it locally.</p>
              )}
            </div>
          </div>
        </div>
      )}
      {linkDialog && (
        <div className="ticket-detail__preview-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) cancelLinkDialog(); }}>
          <div className="ticket-detail__link-dialog">
            <div className="ticket-detail__link-dialog__header">
              <strong>Insert link</strong>
              <button type="button" className="ticket-detail__close" onClick={cancelLinkDialog} aria-label="Close">✕</button>
            </div>
            <div className="ticket-detail__link-dialog__body">
              <label className="ticket-detail__link-dialog__field">
                <span>Display text</span>
                <input
                  ref={linkTextInputRef}
                  type="text"
                  value={linkDialog.displayText}
                  placeholder="Text to show"
                  onChange={(e) => setLinkDialog((prev) => prev ? { ...prev, displayText: e.target.value } : prev)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); confirmLinkDialog(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelLinkDialog(); }
                  }}
                />
              </label>
              <label className="ticket-detail__link-dialog__field">
                <span>Link URL</span>
                <input
                  ref={linkUrlInputRef}
                  type="url"
                  value={linkDialog.url}
                  placeholder="https://example.com"
                  onChange={(e) => setLinkDialog((prev) => prev ? { ...prev, url: e.target.value } : prev)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); confirmLinkDialog(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelLinkDialog(); }
                  }}
                />
              </label>
            </div>
            <div className="ticket-detail__link-dialog__actions">
              <button type="button" className="ticket-detail__btn ticket-detail__btn--ghost" onClick={cancelLinkDialog}>Cancel</button>
              <button type="button" className="ticket-detail__btn ticket-detail__btn--primary" onClick={confirmLinkDialog} disabled={!linkDialog.url.trim()}>Save</button>
            </div>
          </div>
        </div>
      )}
      {lifecycleBarTip
        ? createPortal(
            <div
              className="ticket-detail__lifecycle-bar-tooltip"
              style={{
                position: 'fixed',
                left: lifecycleBarTip.x,
                top: lifecycleBarTip.y,
                transform: 'translate(-50%, calc(-100% - 10px))',
                zIndex: 20000,
              }}
              role="tooltip"
            >
              <div className="ticket-detail__lifecycle-bar-tooltip-title">{lifecycleBarTip.seg.statusLabel}</div>
              {isInstantTerminalDone(lifecycleBarTip.seg) ? (
                <div className="ticket-detail__lifecycle-bar-tooltip-range">
                  Completed {formatLifecycleDate(lifecycleBarTip.seg.endedAtIso ?? lifecycleBarTip.seg.startedAtIso)}
                </div>
              ) : (
                <>
                  <div className="ticket-detail__lifecycle-bar-tooltip-dur">
                    {formatDurationMinutePrecision(lifecycleBarTip.seg.durationMs)}
                  </div>
                  <div className="ticket-detail__lifecycle-bar-tooltip-range">
                    {formatLifecycleDate(lifecycleBarTip.seg.startedAtIso)}
                    {lifecycleBarTip.seg.endedAtIso
                      ? ` → ${formatLifecycleDate(lifecycleBarTip.seg.endedAtIso)}`
                      : ' → …'}
                    {lifecycleBarTip.seg.isOngoing ? ' · current' : ''}
                  </div>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

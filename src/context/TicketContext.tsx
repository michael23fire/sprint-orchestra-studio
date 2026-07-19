import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { Ticket, TicketStatus, TicketPriority, TicketLabel, IssueType } from '../types/ticket';
import {
  FLAGGED_API_LABEL,
  hasValidStoryPoints,
  labelsForIssueType,
  normalizeStatusForIssueType,
  requiresSprintEstimate,
} from '../types/ticket';
import type { Sprint, SprintStatus, SprintReorderAction } from '../types/sprint';
import { useSpaces } from './SpaceContext';
import { useCurrentUser } from './UserContext';
import { issueApi, sprintApi, commentApi, issueLinkApi, codeLinkApi } from '../api';
import type { IssueDto, SprintDto, UpdateIssueRequest } from '../api';
import { USERS } from './UserContext';
import { getDescendantKeys, getDescendantSubtaskKeys, isSubtask, withDerivedEpicStatuses } from '../utils/ticketHierarchy';
import { findOverlappingSprint, validateSprintDates } from '../utils/sprintConstraints';

/**
 * REST APIs use numeric DB space ids. Client-only ids like `space-173...` must not be used.
 * Empty string parses as 0 with Number('') — also invalid for our routes.
 */
function parseBackendSpaceId(id: string): number | null {
  const t = id.trim();
  if (!t || !/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n > 0 ? n : null;
}

function toIsoDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return undefined;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function ticketsFromLeanAndMergeDetails(
  spaceIdNum: number,
  issueDtos: IssueDto[],
  mergeDetailForKeys?: string[],
): Promise<Ticket[]> {
  let tickets = issueDtos.map(issueDtoToTicket);
  const keys = [...new Set(mergeDetailForKeys ?? [])].filter(Boolean);
  for (const key of keys) {
    try {
      const dto = await issueApi.getByKey(spaceIdNum, key);
      tickets = tickets.map((t) => (t.id === key ? issueDtoToTicket(dto) : t));
    } catch {
      /* keep lean row */
    }
  }
  return withDerivedEpicStatuses(tickets);
}

function issueDtoToTicket(dto: IssueDto): Ticket {
  const apiLabels = dto.labels ?? [];
  const issueType = (dto.issueType as IssueType) ?? 'task';
  return {
    id: dto.issueKey,
    dbId: dto.id,
    createdAt: dto.createdAt ?? undefined,
    updatedAt: dto.updatedAt ?? undefined,
    title: dto.title,
    issueType,
    description: dto.description ?? undefined,
    status: normalizeStatusForIssueType(issueType, (dto.status as TicketStatus) ?? 'planned'),
    assignee: dto.assigneeName ?? undefined,
    assigneeId: dto.assigneeId ?? undefined,
    reporter: dto.reporterName ?? undefined,
    reporterId: dto.reporterId ?? undefined,
    dueDate: dto.dueDate ?? undefined,
    startDate: dto.startDate ?? undefined,
    storyPoints: requiresSprintEstimate(issueType) ? (dto.storyPoints ?? undefined) : undefined,
    priority: (dto.priority as TicketPriority) ?? undefined,
    labels: labelsForIssueType(
      issueType,
      apiLabels.filter((label) => label !== FLAGGED_API_LABEL) as TicketLabel[],
    ),
    flagged: dto.flagged === true || apiLabels.includes(FLAGGED_API_LABEL),
    parentId: dto.parentKey ?? undefined,
    subtaskIds: dto.childKeys ?? undefined,
    sprintId: dto.sprintId != null ? String(dto.sprintId) : undefined,
    sprint: dto.sprintName ?? undefined,
    issueOrder: dto.issueOrder ?? 0,
    comments: dto.comments?.map((c) => ({
      id: String(c.id),
      authorId: c.authorId,
      author: c.authorName,
      content: c.content,
      createdAt: c.createdAt,
    })) ?? [],
    linkedIssues: dto.linkedIssues?.map((l) => ({
      id: l.id,
      relation: l.relation,
      linkedIssueKey: l.linkedIssueKey,
      linkedIssueTitle: l.linkedIssueTitle,
      createdAt: l.createdAt,
    })) ?? [],
    attachments: dto.attachments?.map((a) => ({
      id: a.id,
      originalFilename: a.originalFilename,
      contentType: a.contentType ?? undefined,
      sizeBytes: a.sizeBytes,
      uploaderName: a.uploaderName ?? undefined,
      createdAt: a.createdAt,
      listInAttachmentPanel: a.listInAttachmentPanel !== false,
    })) ?? [],
    codeLinks: dto.codeLinks?.map((c) => ({
      id: c.id,
      url: c.url,
      kind: c.kind,
      provider: c.provider,
      owner: c.owner ?? undefined,
      repo: c.repo ?? undefined,
      refId: c.refId ?? undefined,
      title: c.title ?? undefined,
      state: c.state ?? undefined,
      authorLogin: c.authorLogin ?? undefined,
      creatorName: c.creatorName ?? undefined,
      createdAt: c.createdAt,
      lastActivityAt: c.lastActivityAt ?? undefined,
    })) ?? [],
  };
}

function buildIssueUpdateBody(
  updated: Ticket,
  parentDbId: number | undefined,
  clearParent: boolean,
): UpdateIssueRequest {
  const hasAssignee = Boolean(updated.assignee?.trim());
  const hasReporter = Boolean(updated.reporter?.trim());
  let assigneeId =
    updated.assigneeId ??
    (hasAssignee ? Number(USERS.find((u) => u.name === updated.assignee)?.id) : undefined);
  let reporterId =
    updated.reporterId ??
    (hasReporter ? Number(USERS.find((u) => u.name === updated.reporter)?.id) : undefined);
  if (assigneeId !== undefined && Number.isNaN(assigneeId)) assigneeId = undefined;
  if (reporterId !== undefined && Number.isNaN(reporterId)) reporterId = undefined;

  return {
    title: updated.title,
    description: updated.description,
    issueType: updated.issueType,
    status: normalizeStatusForIssueType(updated.issueType, updated.status),
    priority: updated.priority,
    storyPoints: updated.storyPoints,
    labels: [
      ...labelsForIssueType(updated.issueType, updated.labels),
      ...(updated.flagged ? [FLAGGED_API_LABEL] : []),
    ],
    sprintId: updated.sprintId ? Number(updated.sprintId) : undefined,
    clearSprint: !updated.sprintId,
    parentId: parentDbId,
    clearParent,
    startDate: toIsoDate(updated.startDate),
    dueDate: toIsoDate(updated.dueDate),
    issueOrder: updated.issueOrder,
    assigneeId: hasAssignee ? assigneeId : undefined,
    clearAssignee: !hasAssignee,
    reporterId: hasReporter ? reporterId : undefined,
    clearReporter: !hasReporter,
  };
}

function sprintDtoToSprint(dto: SprintDto): Sprint {
  return {
    id: String(dto.id),
    name: dto.name,
    goal: dto.goal ?? undefined,
    startDate: dto.startDate ?? '',
    endDate: dto.endDate ?? '',
    status: (dto.status as SprintStatus) ?? 'future',
    sprintOrder: dto.sprintOrder,
    initialCommittedPoints: dto.initialCommittedPoints ?? undefined,
    initialCompletedPoints: dto.initialCompletedPoints ?? undefined,
    finalScopePoints: dto.finalScopePoints ?? undefined,
    completedPoints: dto.completedPoints ?? undefined,
    initialIssueCount: dto.initialIssueCount ?? undefined,
    completedIssueCount: dto.completedIssueCount ?? undefined,
    finalIssueCount: dto.finalIssueCount ?? undefined,
    unestimatedIssueCount: dto.unestimatedIssueCount ?? undefined,
    commitmentCompletionPercent: dto.commitmentCompletionPercent ?? undefined,
    finalScopeCompletionPercent: dto.finalScopeCompletionPercent ?? undefined,
  };
}

interface SpaceData {
  tickets: Ticket[];
  sprints: Sprint[];
}

interface TicketContextValue {
  tickets: Ticket[];
  sprints: Sprint[];
  setTickets: React.Dispatch<React.SetStateAction<Ticket[]>>;
  setSprints: React.Dispatch<React.SetStateAction<Sprint[]>>;
  addTicket: (ticket: Ticket) => void;
  /** Resolves true when the change was accepted (or API mode is off), false when the server rejected/was unreachable. */
  updateTicket: (updated: Ticket) => Promise<boolean>;
  updateTicketStatus: (
    ticketId: string,
    newStatus: TicketStatus,
    options?: {
      cascadeSubtasks?: boolean;
      /** New root ordering for affected board columns. */
      rankUpdates?: Array<{ ticketId: string; issueOrder: number }>;
    },
  ) => void;
  /** Persist backlog/sprint root ranking (and optional sprint move) like Jira rank. */
  applyBacklogRank: (
    updates: Array<{ ticketId: string; issueOrder: number; sprintId?: string | null }>,
  ) => void;
  createSubtask: (parentId: string, title: string) => Promise<boolean>;
  createSprint: () => void;
  startSprint: (sprintId: string, updates: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>) => void;
  completeSprint: (
    sprintId: string,
    options?: {
      incompleteDestination?: 'backlog' | 'future_sprint' | 'new_sprint';
      moveToSprintId?: string;
      newSprintName?: string;
    },
  ) => void;
  reorderSprint: (sprintId: string, action: SprintReorderAction) => void;
  updateSprint: (sprintId: string, updates: Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate'>>) => void;
  deleteSprint: (sprintId: string) => void;
  createIssueInSprint: (sprintId: string | null, title: string, storyPoints?: number) => void;
  deleteTicket: (ticketId: string) => void;
  addComment: (issueDbId: number, authorId: number, content: string) => void;
  editComment: (issueDbId: number, commentId: number, content: string) => void;
  deleteComment: (issueDbId: number, commentId: number) => void;
  addIssueLink: (issueDbId: number, relation: string, targetIssueKey: string) => Promise<void>;
  deleteIssueLink: (issueDbId: number, linkId: number) => Promise<void>;
  addCodeLink: (issueDbId: number, url: string) => Promise<void>;
  deleteCodeLink: (issueDbId: number, linkId: number) => Promise<void>;
  refreshCodeLinks: (issueDbId: number) => Promise<{ checked: number; updated: number }>;
  nextId: string;
  refreshData: (options?: { mergeDetailForKeys?: string[] }) => void;
  /** Fetches one issue with comments/links/attachments and merges into board state. */
  hydrateIssueDetail: (issueKey: string) => Promise<void>;
  /** True until the first successful fetch for the current space completes. */
  loading: boolean;
}

const TicketContext = createContext<TicketContextValue | null>(null);

export function TicketProvider({ children }: { children: React.ReactNode }) {
  const { currentSpace } = useSpaces();
  const { currentUser, apiReady } = useCurrentUser();

  const [dataBySpace, setDataBySpace] = useState<Record<string, SpaceData>>({});
  // Track which spaces have completed their first fetch so that consumers
  // (e.g. the standalone TicketDetail page) can distinguish "still loading"
  // from "loaded but ticket doesn't exist" and avoid flashing a Not-Found
  // page before data arrives.
  const [loadedSpaces, setLoadedSpaces] = useState<Record<string, boolean>>({});

  const spaceId = currentSpace.id;
  const spaceIdNum = parseBackendSpaceId(spaceId);
  const canApi = apiReady && spaceIdNum != null;

  const currentData = useMemo(
    () => dataBySpace[spaceId] ?? { tickets: [], sprints: [] },
    [dataBySpace, spaceId],
  );

  const fetchFromApi = useCallback((options?: { mergeDetailForKeys?: string[] }) => {
    if (!canApi || spaceIdNum == null) return;
    Promise.all([
      issueApi.getBySpace(spaceIdNum),
      sprintApi.getBySpace(spaceIdNum),
    ]).then(async ([issueDtos, sprintDtos]) => {
      const tickets = await ticketsFromLeanAndMergeDetails(
        spaceIdNum,
        issueDtos,
        options?.mergeDetailForKeys,
      );
      const sprints = sprintDtos.map(sprintDtoToSprint);
      const rawStatusByKey = new Map(issueDtos.map((dto) => [dto.issueKey, dto.status]));
      const epicStatusUpdates = tickets.filter(
        (ticket) => ticket.issueType === 'epic' && rawStatusByKey.get(ticket.id) !== ticket.status,
      );
      if (epicStatusUpdates.length > 0) {
        void Promise.allSettled(
          epicStatusUpdates.map((epic) => issueApi.update(spaceIdNum, epic.id, { status: epic.status })),
        );
      }
      // Only these keys were re-fetched with full detail this round; trust them verbatim.
      const hydratedKeys = new Set(options?.mergeDetailForKeys ?? []);
      setDataBySpace((prev) => {
        // The lean space list returns EMPTY [] for detail collections (links/comments/…),
        // not undefined — so a plain rebuild silently blanks every issue's links, making an
        // open modal show "No linked work items" for links that exist server-side. Keep the
        // last hydrated collections for issues we did NOT just re-fetch.
        const prevById = new Map((prev[spaceId]?.tickets ?? []).map((t) => [t.id, t]));
        const merged = tickets.map((t) => {
          if (hydratedKeys.has(t.id)) return t;
          const old = prevById.get(t.id);
          if (!old) return t;
          return {
            ...t,
            linkedIssues: old.linkedIssues ?? t.linkedIssues,
            comments: old.comments ?? t.comments,
            codeLinks: old.codeLinks ?? t.codeLinks,
            attachments: old.attachments ?? t.attachments,
          };
        });
        return {
          ...prev,
          [spaceId]: { tickets: merged, sprints },
        };
      });
      setLoadedSpaces((prev) => (prev[spaceId] ? prev : { ...prev, [spaceId]: true }));
    }).catch(() => {});
  }, [canApi, spaceIdNum, spaceId]);

  useEffect(() => {
    if (apiReady) fetchFromApi();
  }, [apiReady, spaceId, fetchFromApi]);

  useEffect(() => {
    const refreshAfterLabelChange = () => fetchFromApi();
    window.addEventListener('space-labels-changed', refreshAfterLabelChange);
    return () => window.removeEventListener('space-labels-changed', refreshAfterLabelChange);
  }, [fetchFromApi]);

  const setTickets: React.Dispatch<React.SetStateAction<Ticket[]>> = useCallback(
    (action) => {
      setDataBySpace((prev) => {
        const old = prev[spaceId] ?? { tickets: [], sprints: [] };
        const changedTickets = typeof action === 'function' ? action(old.tickets) : action;
        const newTickets = withDerivedEpicStatuses(changedTickets);
        return { ...prev, [spaceId]: { ...old, tickets: newTickets } };
      });
    },
    [spaceId],
  );

  const hydrateIssueDetail = useCallback(
    async (issueKey: string) => {
      if (!canApi || spaceIdNum == null || !issueKey) return;
      try {
        const dto = await issueApi.getByKey(spaceIdNum, issueKey);
        const merged = issueDtoToTicket(dto);
        setTickets((prev) => {
          const idx = prev.findIndex((t) => t.id === issueKey);
          // On the standalone /ticket/:key page (opened in a new tab) hydrate races the
          // slower full-list load and can arrive first — the issue isn't in the list yet.
          // Insert it instead of dropping the detail; the list rebuild dedups by id and
          // preserves these hydrated collections.
          if (idx < 0) return [...prev, merged];
          const next = [...prev];
          next[idx] = merged;
          return next;
        });
      } catch {
        /* ignore */
      }
    },
    [canApi, spaceIdNum, setTickets],
  );

  const setSprints: React.Dispatch<React.SetStateAction<Sprint[]>> = useCallback(
    (action) => {
      setDataBySpace((prev) => {
        const old = prev[spaceId] ?? { tickets: [], sprints: [] };
        const newSprints = typeof action === 'function' ? action(old.sprints) : action;
        return { ...prev, [spaceId]: { ...old, sprints: newSprints } };
      });
    },
    [spaceId],
  );

  // ── Add ticket (from CreateTaskModal's addTicket path) ──
  const addTicket = useCallback(
    (ticket: Ticket) => {
      if (ticket.sprintId && requiresSprintEstimate(ticket.issueType) && !hasValidStoryPoints(ticket.storyPoints)) {
        alert('Story points are required before adding this issue to a sprint.');
        return;
      }
      setTickets((prev) => [...prev, ticket]);
      if (canApi && spaceIdNum != null) {
        issueApi.create(spaceIdNum, {
          title: ticket.title,
          description: ticket.description,
          issueType: ticket.issueType,
          status: normalizeStatusForIssueType(ticket.issueType, ticket.status),
          priority: ticket.priority,
          storyPoints: ticket.storyPoints,
          labels: ticket.labels,
          sprintId:
            ticket.issueType === 'epic' ? undefined : ticket.sprintId ? Number(ticket.sprintId) : undefined,
          startDate: toIsoDate(ticket.startDate),
          dueDate: toIsoDate(ticket.dueDate),
          assigneeId: ticket.assigneeId,
          reporterId: ticket.reporterId ?? Number(currentUser.id),
        }).then(() => fetchFromApi()).catch(() => {});
      }
    },
    [setTickets, canApi, spaceIdNum, fetchFromApi, currentUser.id],
  );

  // ── Update ticket (from TicketDetailModal) ──
  const updateTicket = useCallback(
    (updated: Ticket) => {
      const existing = currentData.tickets.find((t) => t.id === updated.id);
      if (existing && !isSubtask(existing) && isSubtask(updated)) {
        alert('An existing issue cannot be converted to a subtask. Create it from a parent issue using Create child issue.');
        return Promise.resolve(false);
      }
      // Subtask type is locked once created — ignore any attempted type change.
      const typeLocked: Ticket =
        existing && isSubtask(existing) ? { ...updated, issueType: 'subtask' } : updated;
      const normalized: Ticket =
        typeLocked.issueType === 'epic'
          ? { ...typeLocked, parentId: undefined, sprintId: undefined, sprint: '' }
          : typeLocked;
      if (
        normalized.sprintId
        && requiresSprintEstimate(normalized.issueType)
        && !hasValidStoryPoints(normalized.storyPoints)
      ) {
        alert('Story points are required before assigning this issue to a sprint.');
        return Promise.resolve(false);
      }
      const parentDbId = normalized.parentId
        ? currentData.tickets.find((t) => t.id === normalized.parentId)?.dbId
        : undefined;
      const clearParent = !normalized.parentId;
      setTickets((prev) => {
        const old = prev.find((t) => t.id === normalized.id);
        const subtaskDescendants = !isSubtask(normalized)
          ? getDescendantSubtaskKeys(normalized.id, prev)
          : [];
        const sprintCascade =
          Boolean(old) &&
          !isSubtask(normalized) &&
          (old!.sprintId !== normalized.sprintId || old!.sprint !== normalized.sprint);
        return prev.map((t) => {
          if (t.id === normalized.id) return { ...normalized, subtaskIds: t.subtaskIds };
          if (subtaskDescendants.includes(t.id)) {
            let next = t;
            if (sprintCascade) next = { ...next, sprintId: normalized.sprintId, sprint: normalized.sprint };
            return next;
          }
          return t;
        });
      });
      if (canApi && spaceIdNum != null) {
        return issueApi.update(spaceIdNum, normalized.id, buildIssueUpdateBody(normalized, parentDbId, clearParent))
          .then(() => {
            fetchFromApi({ mergeDetailForKeys: [normalized.id] });
            return true;
          })
          .catch((e) => {
            fetchFromApi({ mergeDetailForKeys: [normalized.id] });
            alert(e instanceof Error ? e.message : 'Failed to update issue');
            return false;
          });
      }
      return Promise.resolve(true);
    },
    [setTickets, canApi, spaceIdNum, fetchFromApi, currentData.tickets],
  );

  // ── Rank backlog / sprint roots (drag reorder) ──
  const applyBacklogRank = useCallback(
    (updates: Array<{ ticketId: string; issueOrder: number; sprintId?: string | null }>) => {
      if (updates.length === 0) return;
      const byId = new Map(updates.map((u) => [u.ticketId, u]));
      const movedWithSprint = updates.find((u) => u.sprintId !== undefined);
      if (movedWithSprint?.sprintId) {
        const moving = currentData.tickets.find((ticket) => ticket.id === movedWithSprint.ticketId);
        if (moving && requiresSprintEstimate(moving.issueType) && !hasValidStoryPoints(moving.storyPoints)) {
          alert(`Add story points to ${moving.id} before moving it into a sprint.`);
          return;
        }
      }

      setTickets((prev) => {
        const sprintName =
          movedWithSprint && movedWithSprint.sprintId
            ? currentData.sprints.find((s) => s.id === movedWithSprint.sprintId)?.name
            : undefined;
        const cascadeKeys =
          movedWithSprint && movedWithSprint.sprintId !== undefined
            ? (() => {
                const moved = prev.find((t) => t.id === movedWithSprint.ticketId);
                if (!moved || isSubtask(moved)) return [] as string[];
                return getDescendantSubtaskKeys(moved.id, prev);
              })()
            : [];

        return prev.map((t) => {
          const u = byId.get(t.id);
          if (u) {
            const next: Ticket = { ...t, issueOrder: u.issueOrder };
            if (u.sprintId !== undefined) {
              next.sprintId = u.sprintId ?? undefined;
              next.sprint = u.sprintId ? sprintName : undefined;
            }
            return next;
          }
          if (cascadeKeys.includes(t.id) && movedWithSprint && movedWithSprint.sprintId !== undefined) {
            return {
              ...t,
              sprintId: movedWithSprint.sprintId ?? undefined,
              sprint: movedWithSprint.sprintId ? sprintName : undefined,
            };
          }
          return t;
        });
      });

      if (canApi && spaceIdNum != null) {
        const tickets = currentData.tickets;
        Promise.all(
          updates.map((u) => {
            const t = tickets.find((x) => x.id === u.ticketId);
            if (!t?.dbId && !t) return Promise.resolve();
            const body: UpdateIssueRequest = { issueOrder: u.issueOrder };
            if (u.sprintId !== undefined) {
              if (u.sprintId) body.sprintId = Number(u.sprintId);
              else body.clearSprint = true;
            }
            return issueApi.update(spaceIdNum, u.ticketId, body);
          }),
        )
          .then(() => fetchFromApi())
          .catch((e) => {
            fetchFromApi();
            alert(e instanceof Error ? e.message : 'Failed to reorder issues');
          });
      }
    },
    [setTickets, canApi, spaceIdNum, fetchFromApi, currentData.tickets, currentData.sprints],
  );

  // ── Update ticket status (board drag & drop) ──
  // When a collapsed parent is moved, cascadeSubtasks moves all descendant
  // subtasks with it. Expanded parents / individual subtasks move alone.
  const updateTicketStatus = useCallback(
    (
      ticketId: string,
      newStatus: TicketStatus,
      options?: {
        cascadeSubtasks?: boolean;
        rankUpdates?: Array<{ ticketId: string; issueOrder: number }>;
      },
    ) => {
      const moving = currentData.tickets.find((t) => t.id === ticketId);
      const shouldCascade =
        Boolean(options?.cascadeSubtasks) && Boolean(moving) && !isSubtask(moving!);
      const keys = shouldCascade
        ? [ticketId, ...getDescendantSubtaskKeys(ticketId, currentData.tickets)]
        : [ticketId];
      const keySet = new Set(keys);
      const rankById = new Map(
        (options?.rankUpdates ?? []).map((update) => [update.ticketId, update.issueOrder]),
      );

      setTickets((prev) =>
        prev.map((t) => {
          const rankedOrder = rankById.get(t.id);
          if (!keySet.has(t.id) && rankedOrder === undefined) return t;
          return {
            ...t,
            ...(keySet.has(t.id) ? { status: newStatus } : {}),
            ...(rankedOrder !== undefined ? { issueOrder: rankedOrder } : {}),
          };
        }),
      );
      if (canApi && spaceIdNum != null) {
        const idsToUpdate = new Set([...keys, ...rankById.keys()]);
        Promise.all(Array.from(idsToUpdate, (id) => {
          const body: UpdateIssueRequest = {};
          if (keySet.has(id)) body.status = newStatus;
          const rankedOrder = rankById.get(id);
          if (rankedOrder !== undefined) body.issueOrder = rankedOrder;
          return issueApi.update(spaceIdNum, id, body);
        }))
          .then(() => fetchFromApi())
          .catch(() => {
            fetchFromApi();
          });
      }
    },
    [setTickets, canApi, spaceIdNum, currentData.tickets, fetchFromApi],
  );

  // ── Create subtask ──
  const createSubtask = useCallback(
    async (parentId: string, title: string): Promise<boolean> => {
      const parentTicket = currentData.tickets.find((t) => t.id === parentId);
      if (parentTicket?.issueType === 'epic') {
        window.alert(
          'Epics do not have subtasks in Jira. Create a story or task and link it to this epic, then add subtasks under that work item.',
        );
        return false;
      }
      if (canApi && spaceIdNum != null) {
        if (parentTicket?.dbId == null) {
          window.alert('Cannot create child issue: parent issue is not loaded yet. Close and reopen the issue, then try again.');
          return false;
        }
        try {
          await issueApi.create(spaceIdNum, {
            title,
            issueType: 'subtask',
            status: parentTicket.status ?? 'planned',
            parentId: parentTicket.dbId,
            sprintId: parentTicket.sprintId ? Number(parentTicket.sprintId) : undefined,
            reporterId: Number(currentUser.id),
          });
          await fetchFromApi();
          return true;
        } catch (e) {
          window.alert(e instanceof Error ? e.message : 'Failed to create child issue');
          return false;
        }
      }
      setTickets((prev) => {
        const key = currentSpace.key;
        const nums = prev.map((t) => parseInt(t.id.replace(/\D/g, ''), 10)).filter(Boolean);
        const newId = `${key}-${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
        const parent = prev.find((t) => t.id === parentId);
        const subtask: Ticket = {
          id: newId,
          title,
          status: parent?.status ?? 'planned',
          issueType: 'subtask',
          parentId,
          sprintId: parent?.sprintId,
        };
        return [
          ...prev.map((t) => t.id === parentId ? { ...t, subtaskIds: [...(t.subtaskIds ?? []), newId] } : t),
          subtask,
        ];
      });
      return true;
    },
    [canApi, spaceIdNum, fetchFromApi, setTickets, currentSpace.key, currentData.tickets, currentUser.id],
  );

  // ── Create issue inline (Backlog/Board "Create issue" button) ──
  const createIssueInSprint = useCallback(
    (sprintId: string | null, title: string, storyPoints?: number) => {
      if (sprintId && !hasValidStoryPoints(storyPoints)) {
        alert('Story points are required before adding a task to a sprint.');
        return;
      }
      if (canApi && spaceIdNum != null) {
        issueApi.create(spaceIdNum, {
          title,
          issueType: 'task',
          status: 'planned',
          sprintId: sprintId ? Number(sprintId) : undefined,
          storyPoints,
          reporterId: Number(currentUser.id),
        }).then(() => fetchFromApi()).catch(() => {});
      } else {
        const key = currentSpace.key;
        setTickets((prev) => {
          const nums = prev.map((t) => parseInt(t.id.replace(/\D/g, ''), 10)).filter(Boolean);
          const newId = `${key}-${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
          const newTicket: Ticket = {
            id: newId,
            title,
            status: 'planned',
            issueType: 'task',
            storyPoints,
            reporter: currentUser.name,
            sprintId: sprintId ?? undefined,
          };
          return [...prev, newTicket];
        });
      }
    },
    [canApi, spaceIdNum, fetchFromApi, setTickets, currentSpace.key, currentUser.name, currentUser.id],
  );

  const deleteTicket = useCallback(
    (ticketId: string) => {
      setTickets((prev) => {
        const descendants = getDescendantKeys(ticketId, prev);
        return prev.filter((t) => t.id !== ticketId && !descendants.includes(t.id));
      });
      if (canApi && spaceIdNum != null) {
        issueApi.delete(spaceIdNum, ticketId)
          .then(() => fetchFromApi())
          .catch((e) => {
            fetchFromApi();
            alert(e instanceof Error ? e.message : 'Failed to delete issue');
          });
      }
    },
    [setTickets, canApi, spaceIdNum, fetchFromApi],
  );

  // ── Create sprint ──
  const createSprint = useCallback(() => {
    if (canApi && spaceIdNum != null) {
      sprintApi.create(spaceIdNum, {
        name: `Sprint ${currentData.sprints.length + 1}`,
        status: 'future',
      }).then(() => fetchFromApi()).catch(() => {});
    } else {
      const newSprint: Sprint = {
        id: `sprint-${Date.now()}`,
        name: `Sprint ${currentData.sprints.length + 1}`,
        startDate: '',
        endDate: '',
        status: 'future',
      };
      setSprints((prev) => [...prev, newSprint]);
    }
  }, [canApi, spaceIdNum, currentData.sprints.length, fetchFromApi, setSprints]);

  // ── Start sprint ──
  const startSprint = useCallback(
    (sprintId: string, updates: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>) => {
      const missingPoints = currentData.tickets.filter(
        (ticket) =>
          ticket.sprintId === sprintId
          && requiresSprintEstimate(ticket.issueType)
          && !hasValidStoryPoints(ticket.storyPoints),
      );
      if (missingPoints.length > 0) {
        alert(`Add story points before starting: ${missingPoints.map((ticket) => ticket.id).join(', ')}`);
        return;
      }
      const active = currentData.sprints.find((s) => s.status === 'active' && s.id !== sprintId);
      if (active) {
        alert(`There can only be one active sprint. Complete "${active.name}" first.`);
        return;
      }
      const dateErr = validateSprintDates(updates.startDate, updates.endDate);
      if (dateErr) {
        alert(dateErr);
        return;
      }
      const overlap = findOverlappingSprint(
        currentData.sprints,
        updates.startDate,
        updates.endDate,
        sprintId,
      );
      if (overlap) {
        alert(`Sprint dates overlap with "${overlap.name}" (${overlap.startDate} – ${overlap.endDate}).`);
        return;
      }
      setSprints((prev) => prev.map((s) => s.id === sprintId ? { ...s, ...updates, status: 'active' as SprintStatus } : s));
      if (canApi && spaceIdNum != null) {
        sprintApi.update(spaceIdNum, Number(sprintId), {
          startDate: updates.startDate,
          endDate: updates.endDate,
          goal: updates.goal,
          status: 'active',
        }).catch((e) => {
          fetchFromApi();
          alert(e instanceof Error ? e.message : 'Failed to start sprint');
        });
      }
    },
    [setSprints, canApi, spaceIdNum, currentData.sprints, currentData.tickets, fetchFromApi],
  );

  // ── Complete sprint (Jira-style: choose where incomplete issues go) ──
  const completeSprint = useCallback(
    (
      sprintId: string,
      options?: {
        incompleteDestination?: 'backlog' | 'future_sprint' | 'new_sprint';
        moveToSprintId?: string;
        newSprintName?: string;
      },
    ) => {
      const destination = options?.incompleteDestination ?? 'backlog';
      let destSprintId: string | undefined;
      let destSprintName: string | undefined;
      let createdSprint: Sprint | null = null;

      if (destination === 'future_sprint' && options?.moveToSprintId) {
        destSprintId = options.moveToSprintId;
        destSprintName = currentData.sprints.find((s) => s.id === destSprintId)?.name;
      } else if (destination === 'new_sprint') {
        destSprintId = `sprint-${Date.now()}`;
        destSprintName = options?.newSprintName?.trim() || `Sprint ${currentData.sprints.length + 1}`;
        createdSprint = {
          id: destSprintId,
          name: destSprintName,
          startDate: '',
          endDate: '',
          status: 'future',
        };
      }

      setSprints((prev) => {
        const next = prev.map((s) =>
          s.id === sprintId ? { ...s, status: 'completed' as SprintStatus } : s,
        );
        return createdSprint ? [...next, createdSprint] : next;
      });

      setTickets((prev) =>
        prev.map((t) => {
          if (t.sprintId !== sprintId || t.status === 'done') return t;
          if (destination === 'backlog' || !destSprintId) {
            return { ...t, sprintId: undefined, sprint: undefined };
          }
          return { ...t, sprintId: destSprintId, sprint: destSprintName };
        }),
      );

      if (canApi && spaceIdNum != null) {
        sprintApi
          .complete(spaceIdNum, Number(sprintId), {
            incompleteDestination: destination,
            moveToSprintId:
              destination === 'future_sprint' && options?.moveToSprintId
                ? Number(options.moveToSprintId)
                : undefined,
            newSprintName: destination === 'new_sprint' ? destSprintName : undefined,
          })
          .then(() => fetchFromApi())
          .catch((e) => {
            fetchFromApi();
            alert(e instanceof Error ? e.message : 'Failed to complete sprint');
          });
      }
    },
    [setSprints, setTickets, canApi, spaceIdNum, fetchFromApi, currentData.sprints],
  );

  // ── Reorder future sprint (Jira: move up/down among planned sprints only) ──
  const reorderSprint = useCallback(
    (sprintId: string, action: SprintReorderAction) => {
      const applyLocalReorder = (list: Sprint[]): Sprint[] => {
        const future = list.filter((s) => s.status === 'future');
        const others = list.filter((s) => s.status !== 'future');
        const index = future.findIndex((s) => s.id === sprintId);
        if (index < 0) return list;
        let target = index;
        if (action === 'move_up') target = Math.max(0, index - 1);
        else if (action === 'move_down') target = Math.min(future.length - 1, index + 1);
        else if (action === 'move_to_top') target = 0;
        else if (action === 'move_to_bottom') target = future.length - 1;
        if (target === index) return list;
        const nextFuture = [...future];
        const [moving] = nextFuture.splice(index, 1);
        nextFuture.splice(target, 0, moving);
        const withOrder = nextFuture.map((s, i) => ({ ...s, sprintOrder: i }));
        const completed = others.filter((s) => s.status === 'completed');
        const active = others.filter((s) => s.status === 'active');
        return [...completed, ...active, ...withOrder];
      };

      setSprints(applyLocalReorder);
      if (canApi && spaceIdNum != null) {
        sprintApi.reorder(spaceIdNum, Number(sprintId), { action })
          .then((dtos) => setSprints(dtos.map(sprintDtoToSprint)))
          .catch((e) => {
            fetchFromApi();
            alert(e instanceof Error ? e.message : 'Failed to reorder sprint');
          });
      }
    },
    [setSprints, canApi, spaceIdNum, fetchFromApi],
  );

  // ── Update sprint (name/goal/dates) ──
  const updateSprint = useCallback(
    (sprintId: string, updates: Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate'>>) => {
      const current = currentData.sprints.find((s) => s.id === sprintId);
      if (!current) return;
      const nextStart = updates.startDate ?? current.startDate;
      const nextEnd = updates.endDate ?? current.endDate;
      if (updates.startDate !== undefined || updates.endDate !== undefined) {
        if (nextStart || nextEnd) {
          const dateErr = validateSprintDates(nextStart, nextEnd);
          if (dateErr) {
            alert(dateErr);
            return;
          }
          const overlap = findOverlappingSprint(currentData.sprints, nextStart, nextEnd, sprintId);
          if (overlap) {
            alert(`Sprint dates overlap with "${overlap.name}" (${overlap.startDate} – ${overlap.endDate}).`);
            return;
          }
        }
      }
      setSprints((prev) => prev.map((s) => (s.id === sprintId ? { ...s, ...updates } : s)));
      if (canApi && spaceIdNum != null) {
        sprintApi.update(spaceIdNum, Number(sprintId), updates)
          .then(() => fetchFromApi())
          .catch((e) => {
            fetchFromApi();
            alert(e instanceof Error ? e.message : 'Failed to update sprint');
          });
      }
    },
    [setSprints, canApi, spaceIdNum, fetchFromApi, currentData.sprints],
  );

  // ── Delete sprint ──
  const deleteSprint = useCallback(
    (sprintId: string) => {
      const destination = currentData.sprints.find((s) => s.status === 'future' && s.id !== sprintId) ?? null;
      setSprints((prev) => prev.filter((s) => s.id !== sprintId));
      setTickets((prev) =>
        prev.map((t) =>
          t.sprintId === sprintId
            ? { ...t, sprintId: destination?.id, sprint: destination?.name }
            : t,
        ),
      );
      if (canApi && spaceIdNum != null) {
        sprintApi.delete(spaceIdNum, Number(sprintId))
          .then(() => fetchFromApi())
          .catch((e) => {
            fetchFromApi();
            alert(e instanceof Error ? e.message : 'Failed to delete sprint');
          });
      }
    },
    [setSprints, setTickets, canApi, spaceIdNum, fetchFromApi, currentData.sprints],
  );

  // ── Add comment ──
  const addComment = useCallback(
    (issueDbId: number, authorId: number, content: string) => {
      if (canApi) {
        const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
        commentApi.create(issueDbId, { authorId, content })
          .then(() => fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined))
          .catch(() => {});
      }
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  // ── Edit comment ──
  const editComment = useCallback(
    (issueDbId: number, commentId: number, content: string) => {
      if (canApi) {
        const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
        commentApi.update(issueDbId, commentId, content)
          .then(() => fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined))
          .catch(() => {});
      }
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  // ── Delete comment ──
  const deleteComment = useCallback(
    (issueDbId: number, commentId: number) => {
      if (canApi) {
        const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
        commentApi.delete(issueDbId, commentId)
          .then(() => fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined))
          .catch(() => {});
      }
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  const addIssueLink = useCallback(
    async (issueDbId: number, relation: string, targetIssueKey: string) => {
      if (!canApi) return;
      const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
      await issueLinkApi.create(issueDbId, { relation, targetIssueKey });
      fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined);
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  const deleteIssueLink = useCallback(
    async (issueDbId: number, linkId: number) => {
      if (!canApi) return;
      const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
      await issueLinkApi.delete(issueDbId, linkId);
      fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined);
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  const addCodeLink = useCallback(
    async (issueDbId: number, url: string) => {
      if (!canApi) {
        throw new Error('API is not ready or the space is not loaded. Wait for the board to finish loading, then try again.');
      }
      const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
      await codeLinkApi.create(issueDbId, { url });
      fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined);
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  const deleteCodeLink = useCallback(
    async (issueDbId: number, linkId: number) => {
      if (!canApi) return;
      const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
      await codeLinkApi.delete(issueDbId, linkId);
      fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined);
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  const refreshCodeLinks = useCallback(
    async (issueDbId: number) => {
      if (!canApi) return { checked: 0, updated: 0 };
      const issueKey = currentData.tickets.find((t) => t.dbId === issueDbId)?.id;
      const result = await codeLinkApi.refreshIssue(issueDbId);
      fetchFromApi(issueKey ? { mergeDetailForKeys: [issueKey] } : undefined);
      return result;
    },
    [canApi, fetchFromApi, currentData.tickets],
  );

  const nextId = useMemo(() => {
    const key = currentSpace.key;
    const nums = currentData.tickets
      .map((t) => parseInt(t.id.replace(/\D/g, ''), 10))
      .filter(Boolean);
    return `${key}-${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
  }, [currentData.tickets, currentSpace.key]);

  return (
    <TicketContext.Provider
      value={{
        tickets: currentData.tickets,
        sprints: currentData.sprints,
        setTickets,
        setSprints,
        addTicket,
        updateTicket,
        updateTicketStatus,
        applyBacklogRank,
        createSubtask,
        createSprint,
        startSprint,
        completeSprint,
        reorderSprint,
        updateSprint,
        deleteSprint,
        createIssueInSprint,
        deleteTicket,
        addComment,
        editComment,
        deleteComment,
        addIssueLink,
        deleteIssueLink,
        addCodeLink,
        deleteCodeLink,
        refreshCodeLinks,
        nextId,
        refreshData: fetchFromApi,
        hydrateIssueDetail,
        // We're "loading" whenever any of the prerequisites isn't ready
        // yet. This covers three startup races that would otherwise cause
        // TicketDetail to flash a "Ticket not found" page on a fresh tab:
        //   (1) UserContext hasn't finished its initial auth/user fetch
        //       (apiReady=false);
        //   (2) SpaceContext is still picking the current space so
        //       currentSpace.id is still '' (spaceIdNum is null);
        //   (3) Space is set but its first issue/sprint fetch hasn't
        //       returned yet (loadedSpaces[spaceId] is false).
        // Once all three are satisfied and the ticket still isn't there,
        // we know it genuinely doesn't exist.
        loading: !apiReady || spaceIdNum == null || !loadedSpaces[spaceId],
      }}
    >
      {children}
    </TicketContext.Provider>
  );
}

export function useTickets(): TicketContextValue {
  const ctx = useContext(TicketContext);
  if (!ctx) throw new Error('useTickets must be used inside TicketProvider');
  return ctx;
}

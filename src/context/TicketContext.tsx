import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { Ticket, TicketStatus, TicketPriority, TicketLabel, IssueType } from '../types/ticket';
import type { Sprint, SprintStatus } from '../types/sprint';
import { useSpaces } from './SpaceContext';
import { useCurrentUser } from './UserContext';
import { issueApi, sprintApi, commentApi, issueLinkApi, codeLinkApi } from '../api';
import type { IssueDto, SprintDto, UpdateIssueRequest } from '../api';
import { USERS } from './UserContext';
import { getDescendantKeys, getDescendantSubtaskKeys, isSubtask } from '../utils/ticketHierarchy';

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
  return tickets;
}

function issueDtoToTicket(dto: IssueDto): Ticket {
  return {
    id: dto.issueKey,
    dbId: dto.id,
    createdAt: dto.createdAt ?? undefined,
    title: dto.title,
    issueType: (dto.issueType as IssueType) ?? 'task',
    description: dto.description ?? undefined,
    status: (dto.status as TicketStatus) ?? 'planned',
    assignee: dto.assigneeName ?? undefined,
    assigneeId: dto.assigneeId ?? undefined,
    reporter: dto.reporterName ?? undefined,
    reporterId: dto.reporterId ?? undefined,
    dueDate: dto.dueDate ?? undefined,
    startDate: dto.startDate ?? undefined,
    storyPoints: dto.storyPoints ?? undefined,
    priority: (dto.priority as TicketPriority) ?? undefined,
    labels: (dto.labels as TicketLabel[]) ?? undefined,
    parentId: dto.parentKey ?? undefined,
    subtaskIds: dto.childKeys ?? undefined,
    sprintId: dto.sprintId != null ? String(dto.sprintId) : undefined,
    sprint: dto.sprintName ?? undefined,
    comments: dto.comments?.map((c) => ({
      id: String(c.id),
      authorId: c.authorId,
      author: c.authorName,
      content: c.content,
      createdAt: new Date(c.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
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
    status: updated.status,
    priority: updated.priority,
    storyPoints: updated.storyPoints,
    labels: updated.labels,
    sprintId: updated.sprintId ? Number(updated.sprintId) : undefined,
    clearSprint: !updated.sprintId,
    parentId: parentDbId,
    clearParent,
    startDate: toIsoDate(updated.startDate),
    dueDate: toIsoDate(updated.dueDate),
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
  updateTicket: (updated: Ticket) => void;
  updateTicketStatus: (ticketId: string, newStatus: TicketStatus) => void;
  createSubtask: (parentId: string, title: string) => void;
  createSprint: () => void;
  startSprint: (sprintId: string, updates: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>) => void;
  completeSprint: (sprintId: string) => void;
  createIssueInSprint: (sprintId: string | null, title: string) => void;
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
      setDataBySpace((prev) => ({
        ...prev,
        [spaceId]: { tickets, sprints },
      }));
      setLoadedSpaces((prev) => (prev[spaceId] ? prev : { ...prev, [spaceId]: true }));
    }).catch(() => {});
  }, [canApi, spaceIdNum, spaceId]);

  useEffect(() => {
    if (apiReady) fetchFromApi();
  }, [apiReady, spaceId, fetchFromApi]);

  const setTickets: React.Dispatch<React.SetStateAction<Ticket[]>> = useCallback(
    (action) => {
      setDataBySpace((prev) => {
        const old = prev[spaceId] ?? { tickets: [], sprints: [] };
        const newTickets = typeof action === 'function' ? action(old.tickets) : action;
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
          if (idx < 0) return prev;
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
      setTickets((prev) => [...prev, ticket]);
      if (canApi && spaceIdNum != null) {
        issueApi.create(spaceIdNum, {
          title: ticket.title,
          description: ticket.description,
          issueType: ticket.issueType,
          status: ticket.status,
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
      const normalized: Ticket =
        updated.issueType === 'epic'
          ? { ...updated, parentId: undefined, sprintId: undefined, sprint: '' }
          : updated;
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
        issueApi.update(spaceIdNum, normalized.id, buildIssueUpdateBody(normalized, parentDbId, clearParent))
          .then(() => fetchFromApi({ mergeDetailForKeys: [normalized.id] }))
          .catch((e) => {
            fetchFromApi({ mergeDetailForKeys: [normalized.id] });
            alert(e instanceof Error ? e.message : 'Failed to update issue');
          });
      }
    },
    [setTickets, canApi, spaceIdNum, fetchFromApi, currentData.tickets],
  );

  // ── Update single ticket status (drag & drop) ──
  const updateTicketStatus = useCallback(
    (ticketId: string, newStatus: TicketStatus) => {
      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t)),
      );
      if (canApi && spaceIdNum != null) {
        issueApi.update(spaceIdNum, ticketId, { status: newStatus }).catch(() => {});
      }
    },
    [setTickets, canApi, spaceIdNum],
  );

  // ── Create subtask ──
  const createSubtask = useCallback(
    (parentId: string, title: string) => {
      const parentTicket = currentData.tickets.find((t) => t.id === parentId);
      if (parentTicket?.issueType === 'epic') {
        window.alert(
          'Epics do not have subtasks in Jira. Create a story or task and link it to this epic, then add subtasks under that work item.',
        );
        return;
      }
      if (canApi && spaceIdNum != null) {
        issueApi.create(spaceIdNum, {
          title,
          issueType: 'subtask',
          status: parentTicket?.status ?? 'planned',
          parentId: parentTicket?.dbId,
          sprintId: parentTicket?.sprintId ? Number(parentTicket.sprintId) : undefined,
          reporterId: Number(currentUser.id),
        }).then(() => fetchFromApi()).catch(() => {});
      } else {
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
      }
    },
    [canApi, spaceIdNum, fetchFromApi, setTickets, currentSpace.key, currentData.tickets, currentUser.id],
  );

  // ── Create issue inline (Backlog/Board "Create issue" button) ──
  const createIssueInSprint = useCallback(
    (sprintId: string | null, title: string) => {
      if (canApi && spaceIdNum != null) {
        issueApi.create(spaceIdNum, {
          title,
          issueType: 'task',
          status: 'planned',
          sprintId: sprintId ? Number(sprintId) : undefined,
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
      setSprints((prev) => prev.map((s) => s.id === sprintId ? { ...s, ...updates, status: 'active' as SprintStatus } : s));
      if (canApi && spaceIdNum != null) {
        sprintApi.update(spaceIdNum, Number(sprintId), {
          startDate: updates.startDate,
          endDate: updates.endDate,
          goal: updates.goal,
          status: 'active',
        }).catch(() => {});
      }
    },
    [setSprints, canApi, spaceIdNum],
  );

  // ── Complete sprint ──
  const completeSprint = useCallback(
    (sprintId: string) => {
      setSprints((prev) => prev.map((s) => s.id === sprintId ? { ...s, status: 'completed' as SprintStatus } : s));
      setTickets((prev) => prev.map((t) =>
        t.sprintId === sprintId && t.status !== 'done' ? { ...t, sprintId: undefined } : t
      ));
      if (canApi && spaceIdNum != null) {
        sprintApi.update(spaceIdNum, Number(sprintId), { status: 'completed' })
          .then(() => fetchFromApi())
          .catch(() => {});
      }
    },
    [setSprints, setTickets, canApi, spaceIdNum, fetchFromApi],
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
        createSubtask,
        createSprint,
        startSprint,
        completeSprint,
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

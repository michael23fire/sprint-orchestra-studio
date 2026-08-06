import { api } from './client';

/**
 * Routed through the gateway (`/api/ai/**`, see gateway/src/main/resources/application.yml's
 * `ai-service-draft-task` route), not called directly against ai-service — same auth boundary
 * (JWT, enforced globally for `/api/**` by GatewaySecurityConfig) every other API call in this app
 * goes through, unlike the project's standalone demo page (`demo/index.html`), which talks to
 * ai-service directly with an open CORS policy meant only for local backend-only testing.
 */

/** Consumes a `text/event-stream` response shaped as `event: <name>\ndata: <json>\n\n` frames — the
 *  "stage progress labels, not token streaming" pattern every SSE endpoint in this codebase follows
 *  (see ai-service/app/api/routes.py's `POST /ask/stream` docstring for why: structured/Instructor
 *  outputs can't be meaningfully streamed token-by-token, so this streams *checkpoint* labels instead,
 *  resolving once a `result` frame arrives). Shared by `askStream` and the sprint-recovery stream
 *  variants below rather than duplicating this parser per endpoint. */
async function consumeStageStream<T>(path: string, body: unknown, onStage?: (label: string) => void): Promise<T> {
  const res = await api.postStream(path, body);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Streaming is not supported in this browser.');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let sepIndex = buffer.indexOf('\n\n');
    while (sepIndex !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const lines = frame.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (eventLine && dataLine) {
        const eventName = eventLine.slice('event: '.length);
        const data = JSON.parse(dataLine.slice('data: '.length));
        if (eventName === 'stage') onStage?.(data.label as string);
        else if (eventName === 'result') return data as T;
        else if (eventName === 'error') throw new Error((data.detail as string) ?? 'request failed');
      }
      sepIndex = buffer.indexOf('\n\n');
    }
  }
  throw new Error('Stream ended before a result arrived.');
}

export type IssueType = 'bug' | 'task' | 'story';

export interface TaskDraftDto {
  title: string;
  issueType: IssueType;
  labels: string[];
  estimateStoryPoints: number | null;
  dependencies: string[];
}

export interface DraftTaskResponse {
  draft: TaskDraftDto;
  degraded: boolean;
  latencySeconds: number;
}

export interface EpicDraftDto {
  title: string;
  description: string;
  goals: string[];
}

export interface IssueDraftDto {
  tempId: string;
  title: string;
  description: string;
  issueType: IssueType;
  labels: string[];
  estimateStoryPoints: number | null;
  estimateRationale: string | null;
  dependsOn: string[];
}

export interface SprintBucketDto {
  sprintIndex: number;
  issueTempIds: string[];
  totalPoints: number;
}

export interface PlanEpicResponse {
  epic: EpicDraftDto;
  issues: IssueDraftDto[];
  sprintPlan: SprintBucketDto[];
  degraded: boolean;
  latencySeconds: number;
}

export interface CitationDto {
  issueKey: string;
  chunkType: string;
  sourceId: number;
  content: string;
}

/** One prior turn's final text only — never the tool-call plumbing a completed turn produced
 *  internally (search queries, retrieved chunks, etc.). Matches ai-service's `ChatTurnIn`
 *  (app/api/routes.py): the model only needs to see what was answered, not how it was found. */
export interface ChatTurnDto {
  role: 'user' | 'assistant';
  content: string;
}

/** Server-measured wall-clock split for one /ask(/stream) call — see ai-service's `StageTimingsOut`
 *  (app/api/routes.py). Not the same number as a client-side stopwatch: this is exactly where the
 *  backend spent time (cache lookup / retrieval tool calls / LLM calls), independent of network. */
export interface StageTimingsDto {
  cacheLookupMs: number;
  retrievalMs: number;
  llmMs: number;
  totalMs: number;
}

export interface AskResponseDto {
  answer: string;
  abstained: boolean;
  retrievalRounds: number;
  queriesUsed: string[];
  citations: CitationDto[];
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  cacheHit: boolean;
  stageTimings?: StageTimingsDto;
}

export interface SemanticSearchHitDto {
  issueId: number;
  issueKey: string;
  /** Real cosine similarity (0-1) — backend uses vector-only retrieval for this endpoint
   *  specifically so this number means something (unlike RRF's rank-fusion score elsewhere in this
   *  app), and only returns results that clear a minimum-relevance floor server-side (see
   *  ai-service/app/search/service.py) — so anything returned here is worth showing as a % match. */
  score: number;
  snippet: string;
}

export interface SemanticSearchResponseDto {
  results: SemanticSearchHitDto[];
}

export interface FlaggedIssueDto {
  issueKey: string;
  title: string;
  detail?: string;
}

export type SprintRiskLevel = 'on_track' | 'at_risk' | 'behind';

export interface SprintHealthRequestDto {
  sprintName: string;
  riskLevel: SprintRiskLevel;
  daysRemaining: number | null;
  committedPoints: number | null;
  completedPoints: number | null;
  totalPoints: number | null;
  issueCountsByStatus: Record<string, number>;
  blockedIssues: FlaggedIssueDto[];
  staleIssues: FlaggedIssueDto[];
  unestimatedIssues: FlaggedIssueDto[];
}

export interface SprintHealthResponseDto {
  summary: string;
  recommendations: string[];
  degraded: boolean;
  latencySeconds: number;
}

/**
 * Sprint recovery: diagnose -> grounded root-cause hypotheses -> confidence-gated clarification ->
 * concrete recovery plans -> durable human approval -> idempotent multi-action execution -> wait for
 * a real Jira event (or a manual re-check) -> re-evaluate -> escalate/replan or close. See
 * ai-service/app/sprint_recovery/graph.py's module docstring for the full design rationale — this is
 * a genuinely different LangGraph shape than epic rollout: 3 differently-shaped pauses (not 1), a
 * conditional replan loop bounded by an escalation cap, and re-entry driven by a real Kafka event as
 * well as by a human.
 */
// 'revising' is transient server-side only (approval_node -> plan_node happens within one HTTP call,
// same request-response) — included here for structural completeness, never actually observed by a
// client between calls.
export type RecoveryStatus =
  | 'diagnosing' | 'awaiting_clarification' | 'awaiting_plan_approval' | 'committing' | 'committed'
  | 'waiting_reevaluation' | 'recovered' | 'escalated' | 'rejected' | 'revising' | 'failed';

export type RecoveryActionType = 'link_dependency' | 'change_priority' | 'move_out_of_sprint' | 'add_comment';

export interface RecoveryActionDto {
  actionType: RecoveryActionType;
  targetIssueKey: string;
  dependsOnIssueKey: string | null;
  newPriority: string | null;
  commentBody: string | null;
}

export interface RecoveryPlanDto {
  planId: string;
  name: string;
  rationale: string;
  impactOnGoal: string;
  actions: RecoveryActionDto[];
}

export interface RecoveryHypothesisDto {
  statement: string;
  confidence: 'high' | 'medium' | 'low';
  supportingEvidenceIds: string[];
}

export interface RecoveryEvidenceDto {
  citationId: string;
  issueKey: string;
  sourceType: 'comment' | 'attachment' | 'history' | 'description' | 'structured';
  content: string;
}

export interface RecoveryStatusDto {
  threadId: string;
  status: RecoveryStatus;
  riskSignalCount: number;
  evidence: RecoveryEvidenceDto[];
  hypotheses: RecoveryHypothesisDto[];
  clarificationQuestion: string | null;
  plans: RecoveryPlanDto[];
  committedActions: Record<string, string>;
  escalationRound: number;
  planRevisionRound: number;
  maxPlanRevisionRounds: number;
  tokenUsage: number;
  error: string | null;
  // Only ever populated when status === 'escalated' — a plain-English "what we tried across every
  // escalation round, and why the risk signals still didn't clear" synthesis.
  escalationSummary: string | null;
}

export interface RecoveryCheckpointDto {
  checkpointId: string;
  nextNode: string | null;
  status: string | null;
}

/**
 * Epic rollout: a durable, human-approved commit-to-Jira workflow (see
 * ai-service/app/planning/rollout_graph.py), distinct from planEpic/refinePlan above — those never
 * persist anything (the caller commits via issueApi/sprintApi itself, see PlanEpicModal.tsx). This
 * one pauses server-side (a LangGraph `interrupt()`, checkpointed in Postgres — it survives an
 * ai-service restart while paused) and, once approved, writes the epic + issues to jira-backend
 * itself, exactly once each even across a crash mid-commit. Scope, stated plainly: creates a real
 * epic-type issue + parent-linked child issues; does NOT yet create/assign sprints or the `dependsOn`
 * issue-link rows PlanEpicModal's own commit flow does — see rollout_graph.py's module docstring.
 */
export type RolloutStatus = 'pending_approval' | 'committing' | 'committed' | 'rejected' | 'failed';

export interface RolloutPlanDto {
  epic: EpicDraftDto | null;
  issues: IssueDraftDto[];
  sprintPlan: SprintBucketDto[];
}

export interface RolloutStatusDto {
  threadId: string;
  status: RolloutStatus;
  plan: RolloutPlanDto | null;
  epicIssueKey: string | null;
  committedIssueKeys: Record<string, string>;
  error: string | null;
}

export const aiApi = {
  draftTask: (description: string, existingLabels: string[]) =>
    api.post<DraftTaskResponse>('/api/ai/draft-task', {
      description,
      existing_labels: existingLabels,
    }),
  planEpic: (
    proposal: string,
    existingLabels: string[],
    sprintCapacityPoints: number | null,
    targetSprintCount: number | null,
  ) =>
    api.post<PlanEpicResponse>('/api/ai/plan-epic', {
      proposal,
      existing_labels: existingLabels,
      sprint_capacity_points: sprintCapacityPoints ?? undefined,
      target_sprint_count: targetSprintCount ?? undefined,
    }),
  /** Applies a free-text edit ("add a QA task", "drop the inventory issue") to a plan already
   *  returned by planEpic (or a previous refinePlan call) — never persists anything, same as planEpic. */
  refinePlan: (
    epic: EpicDraftDto,
    issues: IssueDraftDto[],
    instruction: string,
    existingLabels: string[],
    sprintCapacityPoints: number | null,
    targetSprintCount: number | null,
  ) =>
    api.post<PlanEpicResponse>('/api/ai/plan-epic/refine', {
      epic,
      issues,
      instruction,
      existing_labels: existingLabels,
      sprint_capacity_points: sprintCapacityPoints ?? undefined,
      target_sprint_count: targetSprintCount ?? undefined,
    }),
  /** Agentic Q&A over the space's own issues/comments — answers with citations, or abstains rather
   *  than guessing. `spaceIds` scopes retrieval to spaces the caller already has (see SpaceContext) —
   *  see gateway route ai-service-ask's comment for the trust-boundary note on that parameter.
   *  `history` (optional, oldest-first) lets a follow-up resolve context from earlier turns — this
   *  service is stateless, so the caller (AskAiPanel) owns the running transcript and resends it on
   *  every call; omit/pass `[]` for an independent question. */
  ask: (question: string, spaceIds: number[], history: ChatTurnDto[] = []) =>
    api.post<AskResponseDto>('/api/ai/ask', { question, space_ids: spaceIds, history }),
  /** SSE variant of `ask`: identical request/response shape, but `onStage` fires with a
   *  human-readable progress label ("searching the knowledge base", "verifying and finalizing the
   *  answer", ...) as the agent loop passes through each checkpoint it already goes through, instead
   *  of the caller seeing nothing until the whole answer is ready. Resolves with the same
   *  `AskResponseDto` `ask()` returns once the backend's "result" event arrives. See
   *  ai-service/app/api/routes.py's `POST /ask/stream` and `CragAgent.ask`'s `on_stage` parameter. */
  askStream: (question: string, spaceIds: number[], history: ChatTurnDto[] = [], onStage?: (label: string) => void) =>
    consumeStageStream<AskResponseDto>('/api/ai/ask/stream', { question, space_ids: spaceIds, history }, onStage),
  /** Retrieval only, no LLM — ranked issues (deduped, best chunk per issue), not a generated answer.
   *  Backs both the "find related issues" search mode and duplicate-issue detection. */
  search: (query: string, spaceIds: number[], limit = 10) =>
    api.post<SemanticSearchResponseDto>('/api/ai/search', { query, space_ids: spaceIds, limit }),
  /** Turns pre-computed sprint stats (real burndown math, done by the caller) into a short narrative
   *  + recommendations — never calculates risk itself, see app/sprint_health/schemas.py. */
  sprintHealth: (req: SprintHealthRequestDto) =>
    api.post<SprintHealthResponseDto>('/api/ai/sprint-health', req),
  /** Starts a durable rollout: generates a plan (same call planEpic makes), then pauses server-side
   *  for approval. Always returns with status='pending_approval' (or 'failed' if generation itself
   *  failed) — this call alone never writes anything to Jira. */
  startRollout: (
    proposal: string,
    spaceId: number,
    existingLabels: string[] = [],
    sprintCapacityPoints: number | null = null,
    targetSprintCount: number | null = null,
  ) =>
    api.post<RolloutStatusDto>('/api/ai/plan-epic/rollout', {
      proposal,
      space_id: spaceId,
      existing_labels: existingLabels,
      sprint_capacity_points: sprintCapacityPoints ?? undefined,
      target_sprint_count: targetSprintCount ?? undefined,
    }),
  /** SSE variant of `startRollout` — `onStage` fires once ("generating the rollout plan") since
   *  `plan_node` is the only LLM call this graph makes on start; still worth it since that call is the
   *  entire wait. See ai-service's `POST /plan-epic/rollout/stream`. */
  startRolloutStream: (
    proposal: string,
    spaceId: number,
    existingLabels: string[] = [],
    sprintCapacityPoints: number | null = null,
    targetSprintCount: number | null = null,
    onStage?: (label: string) => void,
  ) =>
    consumeStageStream<RolloutStatusDto>('/api/ai/plan-epic/rollout/stream', {
      proposal,
      space_id: spaceId,
      existing_labels: existingLabels,
      sprint_capacity_points: sprintCapacityPoints ?? undefined,
      target_sprint_count: targetSprintCount ?? undefined,
    }, onStage),
  /** Reads current status (a Postgres read via the checkpointer, no node re-execution) — safe to poll,
   *  and the way to check whether a rollout survived an ai-service restart while paused/committing. */
  getRolloutStatus: (threadId: string) =>
    api.get<RolloutStatusDto>(`/api/ai/plan-epic/rollout/${threadId}`),
  /** Resumes a paused rollout with a human decision (`Command(resume=...)` server-side). `edit`
   *  requires the caller's modified epic+issues; `approve`/`reject` ignore them if present. Runs the
   *  commit loop to completion (or failure) before returning. */
  submitRolloutDecision: (
    threadId: string,
    decision: 'approve' | 'edit' | 'reject',
    edited?: { epic: EpicDraftDto; issues: IssueDraftDto[] },
  ) =>
    api.post<RolloutStatusDto>(`/api/ai/plan-epic/rollout/${threadId}/decision`, {
      decision,
      epic: decision === 'edit' ? edited?.epic : undefined,
      issues: decision === 'edit' ? edited?.issues : undefined,
    }),
  /** Retries a rollout stuck at status='failed' from a *clean* failure — jira-backend was briefly
   *  unreachable while ai-service itself stayed up (a real process crash mid-commit needs no explicit
   *  retry call; it self-resumes from the same checkpoint the next time this thread is touched). Only
   *  valid when status is 'failed' — a 409 otherwise. Never re-creates whatever already succeeded. */
  retryRollout: (threadId: string) =>
    api.post<RolloutStatusDto>(`/api/ai/plan-epic/rollout/${threadId}/retry`),

};

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
  | 'diagnosing' | 'no_risk_found' | 'awaiting_clarification'
  | 'awaiting_plan_approval' | 'committing' | 'committed' | 'waiting_reevaluation' | 'recovered'
  | 'escalated' | 'rejected' | 'revising' | 'failed';

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
  maxEscalationRounds: number;
  tokenUsage: number;
  error: string | null;
  // Only ever populated when status === 'escalated' — structured (a card per round), not a single
  // pre-flattened paragraph, so the UI can lay it out readably instead of one wall of text.
  escalationRounds: RecoveryEscalationRoundDto[];
  escalationStillAtRiskReasons: string[];
  // Empty: every flagged issue was acted on at least once across the rounds above — what remains is
  // real engineering time, not more planning. Non-empty: these issue keys were never even attempted.
  escalationUnaddressedIssueKeys: string[];
  // True only when this status was reached without confirming the read model had caught up with its
  // own writes first — staleness can only make a result look more at-risk than reality, never less, so
  // this is worth showing next to an 'escalated'/'diagnosing' status but not a 'recovered' one.
  indexCatchUpTimedOut: boolean;
  // The plan actually being (or already) executed — distinct from `plans`, which is always the
  // *original* 1-3 proposed options and never reflects a human edit. Found live: after an edited plan
  // failed partway through, `plans` still showed the pre-edit action list — wrong action text, and
  // `committedActions`' indices pointing at the wrong entries entirely. Populated once a plan is
  // actually approved; null while still choosing.
  approvedPlan: RecoveryPlanDto | null;
}

export interface RecoveryEscalationRoundDto {
  round: number;
  planName: string;
  rationale: string;
  actions: string[];
}

export interface RecoveryCheckpointDto {
  checkpointId: string;
  nextNode: string | null;
  status: string | null;
  /** ISO-8601 timestamp of when this checkpoint was written; null on older records. */
  createdAt: string | null;
  /** Which specific action this step applied, when the generic step label can't say (a multi-action
   *  plan produces one otherwise-identical "Applying changes in Jira…" row per action). Null elsewhere. */
  detail: string | null;
}

/** Durable lifecycle behind Plan Epic: generate, pause for review, then publish the final edited
 * epic, sprint destinations, child issues, and dependency links server-side. The `/rollout` path is
 * retained for API compatibility; it is no longer presented as a separate product feature. */
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

  /** Starts a sprint-recovery diagnosis workflow. Runs to the first pause — either a clarifying
   *  question (confidence-gated) or a full set of recovery plans (awaiting_plan_approval). */
  startSprintRecovery: (spaceId: number, sprintId: number, sprintName: string) =>
    api.post<RecoveryStatusDto>('/api/ai/sprint-recovery/start', { spaceId, sprintId, sprintName }),
  /** SSE variant of `startSprintRecovery` — `onStage` fires ("detecting risk signals and analyzing
   *  evidence", "generating recovery plans") as `diagnose_node`/`plan_node` are reached; a fresh
   *  diagnosis can chain through both in one call. See ai-service's `POST /sprint-recovery/start/stream`. */
  startSprintRecoveryStream: (spaceId: number, sprintId: number, sprintName: string, onStage?: (label: string) => void) =>
    consumeStageStream<RecoveryStatusDto>('/api/ai/sprint-recovery/start/stream', { spaceId, sprintId, sprintName }, onStage),
  getSprintRecoveryStatus: (threadId: string) =>
    api.get<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}`),
  /** Found live: crash-resume was correct at the graph/API level (same thread_id, /retry picks up
   *  exactly where a killed process left off) but the UI had no way to *discover* that thread_id again
   *  once it was lost from browser memory (modal closed, page reloaded, or the crash itself) —
   *  `startSprintRecovery(Stream)` always minted a fresh thread. Called on mount, before offering
   *  "Analyze Sprint Health"; null means no non-terminal thread exists for this sprint, not an error. */
  findActiveSprintRecovery: (spaceId: number, sprintId: number) =>
    api.get<RecoveryStatusDto | null>(`/api/ai/sprint-recovery/by-sprint?space_id=${spaceId}&sprint_id=${sprintId}`),
  /** Answers the one specific clarifying question the confidence gate raised — folded in as evidence,
   *  loops back into diagnosis (bounded by the server-side max_clarification_rounds). */
  answerSprintRecoveryClarification: (threadId: string, answer: string) =>
    api.post<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/clarify`, { answer }),
  /** SSE variant of `answerSprintRecoveryClarification` — same stage events as the start stream, since
   *  answering can chain straight from `diagnose_node` into `plan_node` again on a confident pass. */
  answerSprintRecoveryClarificationStream: (threadId: string, answer: string, onStage?: (label: string) => void) =>
    consumeStageStream<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/clarify/stream`, { answer }, onStage),
  submitSprintRecoveryDecision: (
    threadId: string,
    decision: 'approve' | 'edit' | 'reject' | 'revise',
    planId?: string,
    actions?: RecoveryActionDto[],
    feedback?: string,
  ) =>
    api.post<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/decision`, {
      decision,
      planId: decision === 'approve' || decision === 'edit' ? planId : undefined,
      actions: decision === 'edit' ? actions : undefined,
      feedback: decision === 'revise' ? feedback : undefined,
    }),
  /** SSE variant of `submitSprintRecoveryDecision` — only `revise` ever emits a `stage` event (it's
   *  the only decision that re-enters `plan_node`, a real LLM call), but every decision goes through
   *  this so the caller has one code path regardless of which button was clicked. */
  submitSprintRecoveryDecisionStream: (
    threadId: string,
    decision: 'approve' | 'edit' | 'reject' | 'revise',
    planId?: string,
    actions?: RecoveryActionDto[],
    feedback?: string,
    onStage?: (label: string) => void,
  ) =>
    consumeStageStream<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/decision/stream`, {
      decision,
      planId: decision === 'approve' || decision === 'edit' ? planId : undefined,
      actions: decision === 'edit' ? actions : undefined,
      feedback: decision === 'revise' ? feedback : undefined,
    }, onStage),
  /** Un-sticks a workflow at status='committing' (a suspected crash) or 'failed' (jira-backend was
   *  briefly unreachable while ai-service stayed up) — same two-case split as retryRollout, applied
   *  to a heterogeneous 4-action-type execution instead of a single homogeneous "create issue" one. */
  retrySprintRecovery: (threadId: string) =>
    api.post<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/retry`),
  /** The manual half of the "human or Kafka event, identical resume protocol" wait — a real
   *  IssueContentChangedEvent calls the same underlying resume from kafka_trigger.py instead. */
  triggerSprintRecoveryReevaluation: (threadId: string) =>
    api.post<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/trigger-reevaluation`),
  /** SSE variant — `reevaluate_node` itself is fast/deterministic, but replanning (when still at
   *  risk and under the escalation cap) chains straight into `plan_node`, a real LLM call worth a
   *  `stage` event for instead of a bare "Checking…" with no feedback. */
  triggerSprintRecoveryReevaluationStream: (threadId: string, onStage?: (label: string) => void) =>
    consumeStageStream<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/trigger-reevaluation/stream`, {}, onStage),
  getSprintRecoveryHistory: (threadId: string) =>
    api.get<RecoveryCheckpointDto[]>(`/api/ai/sprint-recovery/${threadId}/history`),
  /** Rewinds to an earlier checkpoint (from getSprintRecoveryHistory) and continues forward from
   *  there with `note` folded in as if a human had just answered a clarifying question at that point
   *  — rewrites this thread's own forward history, verified live not to fork a separate thread. */
  timeTravelSprintRecovery: (threadId: string, checkpointId: string, note: string) =>
    api.post<RecoveryStatusDto>(`/api/ai/sprint-recovery/${threadId}/time-travel`, { checkpointId, note }),
};

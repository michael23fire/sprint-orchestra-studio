import { api } from './client';

/**
 * Routed through the gateway (`/api/ai/**`, see gateway/src/main/resources/application.yml's
 * `ai-service-draft-task` route), not called directly against ai-service — same auth boundary
 * (JWT, enforced globally for `/api/**` by GatewaySecurityConfig) every other API call in this app
 * goes through, unlike the project's standalone demo page (`demo/index.html`), which talks to
 * ai-service directly with an open CORS policy meant only for local backend-only testing.
 */

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
  askStream: async (
    question: string,
    spaceIds: number[],
    history: ChatTurnDto[] = [],
    onStage?: (label: string) => void,
  ): Promise<AskResponseDto> => {
    const res = await api.postStream('/api/ai/ask/stream', { question, space_ids: spaceIds, history });
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
          else if (eventName === 'result') return data as AskResponseDto;
          else if (eventName === 'error') throw new Error((data.detail as string) ?? 'ask failed');
        }
        sepIndex = buffer.indexOf('\n\n');
      }
    }
    throw new Error('Stream ended before a result arrived.');
  },
  /** Retrieval only, no LLM — ranked issues (deduped, best chunk per issue), not a generated answer.
   *  Backs both the "find related issues" search mode and duplicate-issue detection. */
  search: (query: string, spaceIds: number[], limit = 10) =>
    api.post<SemanticSearchResponseDto>('/api/ai/search', { query, space_ids: spaceIds, limit }),
  /** Turns pre-computed sprint stats (real burndown math, done by the caller) into a short narrative
   *  + recommendations — never calculates risk itself, see app/sprint_health/schemas.py. */
  sprintHealth: (req: SprintHealthRequestDto) =>
    api.post<SprintHealthResponseDto>('/api/ai/sprint-health', req),
};

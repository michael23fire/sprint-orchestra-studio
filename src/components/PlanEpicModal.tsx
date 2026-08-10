import { useEffect, useMemo, useRef, useState } from 'react';
import type { Sprint } from '../types/sprint';
import { labelColor } from '../types/ticket';
import { aiApi, labelApi } from '../api';
import type {
  IssueDraftDto,
  LabelDto,
  PlanEpicResponse,
  RolloutSprintTargetDto,
  RolloutStatusDto,
} from '../api';
import './PlanEpicModal.css';

type Stage = 'input' | 'preview' | 'committing' | 'error';

interface BucketChoice {
  mode: 'existing' | 'new';
  sprintId?: number;
  newName: string;
}

interface SavedPlanEpicDraft {
  epicTitle: string;
  epicDescription: string;
  issues: IssueDraftDto[];
  bucketAssignment: Record<string, number>;
  bucketOrder: number[];
  bucketChoices: Record<number, BucketChoice>;
}

const draftStorageKey = (threadId: string) => `plan-epic-draft:${threadId}`;

function clearSavedDraft(threadId: string) {
  try {
    window.sessionStorage.removeItem(draftStorageKey(threadId));
  } catch {
    // Storage may be unavailable in a locked-down browser; server-side workflow recovery still works.
  }
}

interface PlanEpicModalProps {
  spaceId: number;
  /** Full sprint list for this space — used to offer existing future sprints as commit targets and
   *  to auto-compute a sensible sprint capacity from recent real velocity. */
  sprints: Sprint[];
  /** Refresh callback (wired to TicketContext's refreshData) — called whenever publishing reports
   *  real Jira writes, including a partial failure, so the background reflects what actually landed. */
  onCommitted: () => void;
  onClose: () => void;
}

export function PlanEpicModal({ spaceId, sprints, onCommitted, onClose }: PlanEpicModalProps) {
  const [stage, setStage] = useState<Stage>('input');
  const [proposal, setProposal] = useState('');
  const [spaceLabels, setSpaceLabels] = useState<LabelDto[]>([]);
  const [capacityInput, setCapacityInput] = useState('');
  const [targetSprintCountInput, setTargetSprintCountInput] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  const [workflowThreadId, setWorkflowThreadId] = useState<string | null>(null);
  const [checkingForExisting, setCheckingForExisting] = useState(true);
  const [resumedExisting, setResumedExisting] = useState(false);
  const [degraded, setDegraded] = useState(false);
  /** Params used for the last generate/refine call — reused on refine so bin-packing stays
   *  consistent with what the user originally asked for, without re-prompting for them each time. */
  const [lastCapacity, setLastCapacity] = useState<number | null>(null);
  const [lastTargetSprintCount, setLastTargetSprintCount] = useState<number | null>(null);

  const [epicTitle, setEpicTitle] = useState('');
  const [epicDescription, setEpicDescription] = useState('');
  const [issues, setIssues] = useState<IssueDraftDto[]>([]);
  const [bucketAssignment, setBucketAssignment] = useState<Record<string, number>>({});
  const [bucketOrder, setBucketOrder] = useState<number[]>([]);
  const [bucketChoices, setBucketChoices] = useState<Record<number, BucketChoice>>({});
  const manualIdCounter = useRef(0);

  const [refineInstruction, setRefineInstruction] = useState('');
  const [refineLoading, setRefineLoading] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitProgress, setCommitProgress] = useState<{ created: number; total: number } | null>(null);
  /** Which issue's label picker is expanded — only one at a time, and only shows labels not already
   *  on that issue, so the preview doesn't dump the space's whole label list under every issue. */
  const [labelPickerFor, setLabelPickerFor] = useState<string | null>(null);

  const futureSprints = useMemo(() => sprints.filter((s) => s.status === 'future'), [sprints]);
  const activeBucketCount = useMemo(
    () => bucketOrder.filter((idx) => issues.some((i) => bucketAssignment[i.tempId] === idx)).length,
    [bucketOrder, issues, bucketAssignment],
  );
  const totalPoints = useMemo(
    () => issues.reduce((sum, i) => sum + (i.estimateStoryPoints ?? 0), 0),
    [issues],
  );
  const bucketPointsByIndex = useMemo(() => Object.fromEntries(
    bucketOrder.map((sprintIndex) => [
      sprintIndex,
      issues
        .filter((issue) => bucketAssignment[issue.tempId] === sprintIndex)
        .reduce((sum, issue) => sum + (issue.estimateStoryPoints ?? 0), 0),
    ]),
  ), [bucketOrder, issues, bucketAssignment]);
  const overCapacityBucketCount = useMemo(
    () => lastCapacity == null
      ? 0
      : bucketOrder.filter((index) => (bucketPointsByIndex[index] ?? 0) > lastCapacity).length,
    [bucketOrder, bucketPointsByIndex, lastCapacity],
  );
  const autoCapacity = useMemo(() => {
    const completed = sprints
      .filter((s) => s.status === 'completed' && s.completedPoints != null && s.completedPoints > 0)
      .slice(-3)
      .map((s) => s.completedPoints as number);
    if (completed.length === 0) return 20;
    return Math.round(completed.reduce((a, b) => a + b, 0) / completed.length);
  }, [sprints]);
  const hasEmptyTitle = useMemo(() => issues.some((i) => !i.title.trim()), [issues]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    labelApi.getBySpace(spaceId)
      .then((fetched) => { if (!cancelled) setSpaceLabels(fetched); })
      .catch(() => { /* label suggestions are a nicety — a failed fetch shouldn't block planning */ });
    return () => { cancelled = true; };
  }, [spaceId]);

  function bucketIssues(sprintIndex: number) {
    return issues.filter((i) => bucketAssignment[i.tempId] === sprintIndex);
  }

  function applyPlanResponse(
    response: PlanEpicResponse,
    restoredTargets: RolloutSprintTargetDto[] = [],
  ) {
    setEpicTitle(response.epic.title);
    setEpicDescription(response.epic.description);
    setIssues(response.issues);
    const assignment: Record<string, number> = {};
    const order: number[] = [];
    const choices: Record<number, BucketChoice> = {};
    const targetByIndex = new Map(restoredTargets.map((target) => [target.sprintIndex, target]));
    response.sprintPlan.forEach((bucket) => {
      order.push(bucket.sprintIndex);
      bucket.issueTempIds.forEach((tempId) => { assignment[tempId] = bucket.sprintIndex; });
      const restored = targetByIndex.get(bucket.sprintIndex);
      choices[bucket.sprintIndex] = restored?.mode === 'existing' && restored.sprintId
        ? { mode: 'existing', sprintId: restored.sprintId, newName: '' }
        : {
          mode: 'new',
          newName: restored?.sprintName || `${response.epic.title} — Sprint ${bucket.sprintIndex + 1}`,
        };
    });
    setBucketAssignment(assignment);
    setBucketOrder(order);
    setBucketChoices(choices);
    setDegraded(response.degraded);
  }

  function restoreSavedDraft(threadId: string): boolean {
    try {
      const raw = window.sessionStorage.getItem(draftStorageKey(threadId));
      if (!raw) return false;
      const saved = JSON.parse(raw) as SavedPlanEpicDraft;
      if (typeof saved.epicTitle !== 'string' || !Array.isArray(saved.issues) || !Array.isArray(saved.bucketOrder)) {
        return false;
      }
      setEpicTitle(saved.epicTitle);
      setEpicDescription(saved.epicDescription ?? '');
      setIssues(saved.issues);
      setBucketAssignment(saved.bucketAssignment ?? {});
      setBucketOrder(saved.bucketOrder);
      setBucketChoices(saved.bucketChoices ?? {});
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    if (!workflowThreadId || stage !== 'preview') return;
    const saved: SavedPlanEpicDraft = {
      epicTitle,
      epicDescription,
      issues,
      bucketAssignment,
      bucketOrder,
      bucketChoices,
    };
    try {
      window.sessionStorage.setItem(draftStorageKey(workflowThreadId), JSON.stringify(saved));
    } catch {
      // The durable server checkpoint remains recoverable even if browser storage is unavailable.
    }
  }, [
    workflowThreadId, stage, epicTitle, epicDescription, issues,
    bucketAssignment, bucketOrder, bucketChoices,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await aiApi.findActivePlanEpic(spaceId);
        if (cancelled || !existing?.plan?.epic) return;
        const restoredLocalEdits = restoreSavedDraft(existing.threadId);
        if (!restoredLocalEdits) {
          applyPlanResponse({
            epic: existing.plan.epic,
            issues: existing.plan.issues,
            sprintPlan: existing.plan.sprintPlan,
            degraded: existing.degraded,
            latencySeconds: 0,
          }, existing.plan.sprintTargets);
        } else {
          setDegraded(existing.degraded);
        }
        setWorkflowThreadId(existing.threadId);
        setLastCapacity(existing.sprintCapacityPoints);
        setLastTargetSprintCount(existing.targetSprintCount);
        setResumedExisting(true);
        if (existing.status === 'pending_approval') {
          setStage('preview');
          return;
        }
        const created = Object.keys(existing.committedIssueKeys).length;
        setCommitProgress({ created, total: existing.plan.issues.length });
        setCommitError(
          existing.error
            ? `Published ${created} of ${existing.plan.issues.length} issues before an error: ${existing.error}`
            : `Publishing was interrupted after ${created} of ${existing.plan.issues.length} issues. Resume from the saved checkpoint.`,
        );
        setStage('error');
      } catch {
        // Discovery is best-effort: a fresh Plan Epic remains available if no workflow can be restored.
      } finally {
        if (!cancelled) setCheckingForExisting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [spaceId]);

  async function handleGenerate() {
    if (!proposal.trim() || genLoading) return;
    setGenLoading(true);
    setGenError(null);
    setStageLabel(null);
    try {
      const capacity = capacityInput.trim() ? Number(capacityInput) : autoCapacity;
      const targetCount = targetSprintCountInput.trim() ? Number(targetSprintCountInput) : NaN;
      const resolvedCapacity = Number.isFinite(capacity) ? capacity : null;
      const resolvedTargetCount = Number.isFinite(targetCount) ? targetCount : null;
      const workflow = await aiApi.startRolloutStream(
        proposal.trim(),
        spaceId,
        spaceLabels.map((l) => l.name),
        resolvedCapacity,
        resolvedTargetCount,
        setStageLabel,
      );
      if (!workflow.plan?.epic) {
        throw new Error(workflow.error || 'Plan generation returned no editable plan.');
      }
      applyPlanResponse({
        epic: workflow.plan.epic,
        issues: workflow.plan.issues,
        sprintPlan: workflow.plan.sprintPlan,
        degraded: workflow.degraded,
        latencySeconds: 0,
      });
      setWorkflowThreadId(workflow.threadId);
      setResumedExisting(false);
      setLastCapacity(resolvedCapacity);
      setLastTargetSprintCount(resolvedTargetCount);
      setStage('preview');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Plan generation failed — try again.');
    } finally {
      setGenLoading(false);
      setStageLabel(null);
    }
  }

  async function handleRefine() {
    if (!refineInstruction.trim() || refineLoading) return;
    setRefineLoading(true);
    setRefineError(null);
    try {
      const response = await aiApi.refinePlan(
        { title: epicTitle, description: epicDescription, goals: [] },
        issues,
        refineInstruction.trim(),
        spaceLabels.map((l) => l.name),
        lastCapacity,
        lastTargetSprintCount,
      );
      applyPlanResponse(response);
      setRefineInstruction('');
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : 'Refine failed — try again.');
    } finally {
      setRefineLoading(false);
    }
  }

  function updateIssue(tempId: string, patch: Partial<IssueDraftDto>) {
    setIssues((prev) => prev.map((i) => (i.tempId === tempId ? { ...i, ...patch } : i)));
  }

  function updatePoints(tempId: string, value: string) {
    // A manual point edit invalidates whatever rationale the AI gave for its own number.
    updateIssue(tempId, { estimateStoryPoints: value ? Number(value) : null, estimateRationale: null });
  }

  function toggleIssueLabel(tempId: string, name: string) {
    setIssues((prev) => prev.map((i) => {
      if (i.tempId !== tempId) return i;
      const has = i.labels.includes(name);
      return { ...i, labels: has ? i.labels.filter((l) => l !== name) : [...i.labels, name] };
    }));
  }

  function removeIssue(tempId: string) {
    setIssues((prev) => prev
      .filter((i) => i.tempId !== tempId)
      .map((i) => ({ ...i, dependsOn: i.dependsOn.filter((d) => d !== tempId) })));
    setBucketAssignment((prev) => {
      const next = { ...prev };
      delete next[tempId];
      return next;
    });
    setLabelPickerFor((current) => (current === tempId ? null : current));
  }

  function addIssue(sprintIndex: number) {
    manualIdCounter.current += 1;
    const tempId = `manual-${manualIdCounter.current}`;
    const newIssue: IssueDraftDto = {
      tempId,
      title: '',
      description: '',
      issueType: 'task',
      labels: [],
      estimateStoryPoints: null,
      estimateRationale: null,
      dependsOn: [],
    };
    setIssues((prev) => [...prev, newIssue]);
    setBucketAssignment((prev) => ({ ...prev, [tempId]: sprintIndex }));
  }

  function finalSprintTargets(): RolloutSprintTargetDto[] {
    const targets: RolloutSprintTargetDto[] = [];
    bucketOrder.forEach((sprintIndex) => {
      const issueTempIds = bucketIssues(sprintIndex).map((issue) => issue.tempId);
      if (issueTempIds.length === 0) return;
      const choice = bucketChoices[sprintIndex];
      if (choice?.mode === 'existing') {
        if (!choice.sprintId) throw new Error(`Sprint ${sprintIndex + 1} needs a destination.`);
        targets.push({
          sprintIndex,
          issueTempIds,
          mode: 'existing',
          sprintId: choice.sprintId,
          sprintName: null,
        });
        return;
      }
      targets.push({
        sprintIndex,
        issueTempIds,
        mode: 'new',
        sprintId: null,
        sprintName: choice?.newName.trim() || `${epicTitle.trim()} — Sprint ${sprintIndex + 1}`,
      });
    });
    return targets;
  }

  function completePublish(result: RolloutStatusDto, total: number): boolean {
    const created = Object.keys(result.committedIssueKeys).length;
    setCommitProgress({ created, total });
    if (result.epicIssueKey || created > 0) onCommitted();
    if (result.status === 'committed') {
      if (workflowThreadId) clearSavedDraft(workflowThreadId);
      onClose();
      return true;
    }
    setCommitError(
      result.error
        ? `Published ${created} of ${total} issues before an error: ${result.error}`
        : `Publishing paused after ${created} of ${total} issues. Resume to continue from the saved checkpoint.`,
    );
    setStage('error');
    return false;
  }

  function finalEditedPlan() {
    return {
      epic: { title: epicTitle.trim(), description: epicDescription.trim(), goals: [] },
      issues,
      sprintTargets: finalSprintTargets(),
    };
  }

  async function handleCommit() {
    if (!workflowThreadId) {
      setCommitError('This plan has no durable workflow. Go back and generate it again.');
      setStage('error');
      return;
    }
    setStage('committing');
    setCommitError(null);
    const total = issues.length;
    setCommitProgress({ created: 0, total });
    try {
      const result = await aiApi.submitRolloutDecision(workflowThreadId, 'edit', finalEditedPlan());
      completePublish(result, total);
    } catch (err) {
      try {
        const current = await aiApi.getRolloutStatus(workflowThreadId);
        if (completePublish(current, total)) return;
      } catch {
        setCommitError(
          `${err instanceof Error ? err.message : 'Publishing request failed.'} `
          + 'Workflow progress is stored server-side; use Resume to continue safely.',
        );
        setStage('error');
      }
    }
  }

  async function handleRetry() {
    if (!workflowThreadId) return;
    setStage('committing');
    setCommitError(null);
    try {
      const current = await aiApi.getRolloutStatus(workflowThreadId);
      if (current.status === 'committed') {
        completePublish(current, issues.length);
        return;
      }
      setCommitProgress({
        created: Object.keys(current.committedIssueKeys).length,
        total: issues.length,
      });
      const result = current.status === 'pending_approval'
        ? await aiApi.submitRolloutDecision(workflowThreadId, 'edit', finalEditedPlan())
        : await aiApi.retryRollout(workflowThreadId);
      completePublish(result, issues.length);
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Could not resume publishing.');
      setStage('error');
    }
  }

  async function handleBack() {
    const threadId = workflowThreadId;
    if (threadId) clearSavedDraft(threadId);
    setWorkflowThreadId(null);
    setResumedExisting(false);
    setStage('input');
    if (threadId) {
      try {
        await aiApi.submitRolloutDecision(threadId, 'reject');
      } catch {
        // Returning to the input is still safe: no Jira writes happen before approval.
      }
    }
  }

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal pe-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">✨ Plan Epic with AI</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body pe-body">
          {checkingForExisting && (
            <p className="pe-hint">Checking for an unfinished Plan Epic workflow…</p>
          )}
          {!checkingForExisting && stage === 'input' && (
            <>
              <label className="bl-modal__label" htmlFor="pe-proposal">Proposal</label>
              <textarea
                id="pe-proposal"
                className="bl-modal__input pe-textarea"
                placeholder="e.g. Add dark mode support across the app, including a settings toggle and persisted preference..."
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
                autoFocus
              />
              <div className="pe-row">
                <div className="pe-field">
                  <label className="bl-modal__label" htmlFor="pe-capacity">Capacity per sprint (points)</label>
                  <input
                    id="pe-capacity"
                    className="bl-modal__input"
                    type="number"
                    min="1"
                    placeholder={String(autoCapacity)}
                    value={capacityInput}
                    onChange={(e) => setCapacityInput(e.target.value)}
                  />
                  <span className="pe-hint">
                    Per-sprint ceiling. Auto: recent completed-sprint average ({autoCapacity}).
                  </span>
                </div>
                <div className="pe-field">
                  <label className="bl-modal__label" htmlFor="pe-sprint-count">Desired sprint count (optional)</label>
                  <input
                    id="pe-sprint-count"
                    className="bl-modal__input"
                    type="number"
                    min="1"
                    placeholder="Auto"
                    value={targetSprintCountInput}
                    onChange={(e) => setTargetSprintCountInput(e.target.value)}
                  />
                </div>
              </div>
              {genError && <p className="pe-error">{genError}</p>}
            </>
          )}

          {(stage === 'preview' || stage === 'committing' || stage === 'error') && (
            <>
              {degraded && (
                <p className="pe-hint pe-hint--warn">
                  AI planning was unavailable — this is an unassisted single-issue starting point, not
                  a real decomposition. Review carefully, or close and try again.
                </p>
              )}
              {stage === 'preview' && (
                <p className="pe-hint">
                  Review and edit the complete plan below. Approval publishes the epic, sprint
                  assignments, issues, and dependencies through a durable server-side workflow.
                </p>
              )}
              {resumedExisting && (
                <p className="pe-hint pe-hint--restored">
                  Restored your unfinished Plan Epic workflow from its server checkpoint.
                </p>
              )}
              <div className="pe-field">
                <label className="bl-modal__label" htmlFor="pe-epic-title">Epic title</label>
                <input
                  id="pe-epic-title"
                  className="bl-modal__input"
                  value={epicTitle}
                  disabled={stage !== 'preview'}
                  onChange={(e) => setEpicTitle(e.target.value)}
                />
              </div>
              <div className="pe-field">
                <label className="bl-modal__label" htmlFor="pe-epic-desc">Epic description</label>
                <textarea
                  id="pe-epic-desc"
                  className="bl-modal__input pe-textarea"
                  value={epicDescription}
                  disabled={stage !== 'preview'}
                  onChange={(e) => setEpicDescription(e.target.value)}
                />
              </div>

              <div className="pe-summary">
                <span><strong>{issues.length}</strong> issue{issues.length !== 1 ? 's' : ''}</span>
                <span><strong>{totalPoints}</strong> point{totalPoints !== 1 ? 's' : ''}</span>
                <span><strong>{activeBucketCount}</strong> sprint{activeBucketCount !== 1 ? 's' : ''}</span>
              </div>
              {lastCapacity != null && lastTargetSprintCount != null
                && totalPoints > lastCapacity * lastTargetSprintCount && (
                <p className="pe-capacity-warning">
                  <strong>Capacity conflict:</strong> {totalPoints} points cannot fit into{' '}
                  {lastTargetSprintCount} sprint{lastTargetSprintCount !== 1 ? 's' : ''} ×{' '}
                  {lastCapacity} points ({lastCapacity * lastTargetSprintCount} total). Capacity takes
                  priority, so the plan needs more sprints unless you split or re-estimate the work.
                </p>
              )}
              {lastCapacity != null && overCapacityBucketCount > 0 && (
                <p className="pe-capacity-warning">
                  <strong>{overCapacityBucketCount} sprint bucket{overCapacityBucketCount !== 1 ? 's are' : ' is'} over capacity.</strong>{' '}
                  This happens only when an individual issue is larger than {lastCapacity} points, or
                  after a manual point edit. Split or re-estimate the highlighted work before approval.
                </p>
              )}

              {stage === 'preview' && (
                <div className="pe-refine">
                  <label className="bl-modal__label" htmlFor="pe-refine-instruction">
                    Adjust the plan — like talking it through in sprint planning
                  </label>
                  <div className="pe-refine__row">
                    <input
                      id="pe-refine-instruction"
                      className="bl-modal__input"
                      placeholder="e.g. 'add a QA/testing task', 'combine the two backend setup issues', 'drop the inventory one for MVP'"
                      value={refineInstruction}
                      onChange={(e) => setRefineInstruction(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleRefine(); } }}
                    />
                    <button
                      type="button"
                      className="bl-btn bl-btn--outline"
                      onClick={handleRefine}
                      disabled={!refineInstruction.trim() || refineLoading}
                    >
                      {refineLoading ? 'Applying…' : 'Apply'}
                    </button>
                  </div>
                  {refineError && <p className="pe-error">{refineError}</p>}
                </div>
              )}

              {bucketOrder.map((sprintIndex) => {
                const rows = bucketIssues(sprintIndex);
                if (rows.length === 0 && stage !== 'preview') return null;
                const bucketPoints = bucketPointsByIndex[sprintIndex] ?? 0;
                const overCapacity = lastCapacity != null && bucketPoints > lastCapacity;
                const choice = bucketChoices[sprintIndex] ?? { mode: 'new' as const, newName: '' };
                return (
                  <section className={`pe-bucket${overCapacity ? ' pe-bucket--over-capacity' : ''}`} key={sprintIndex}>
                    <div className="pe-bucket__header">
                      <div className="pe-bucket__identity">
                        <span className="pe-bucket__eyebrow">SPRINT PLAN</span>
                        <span className="pe-bucket__title">Sprint {sprintIndex + 1}</span>
                      </div>
                      <span className={`pe-bucket__points${overCapacity ? ' is-over' : ''}`}>
                        {bucketPoints}{lastCapacity != null ? ` / ${lastCapacity}` : ''} pts
                      </span>
                    </div>
                    <div className="pe-bucket__target">
                      <span className="pe-bucket__section-label">SPRINT DESTINATION</span>
                      <div className="pe-bucket__target-controls">
                        <select
                          className="bl-modal__input"
                          value={choice.mode === 'existing' ? String(choice.sprintId ?? '') : 'new'}
                          disabled={stage !== 'preview'}
                          onChange={(e) => {
                            const value = e.target.value;
                            setBucketChoices((prev) => ({
                              ...prev,
                              [sprintIndex]: value === 'new'
                                ? { mode: 'new', newName: prev[sprintIndex]?.newName || `${epicTitle} — Sprint ${sprintIndex + 1}` }
                                : { mode: 'existing', sprintId: Number(value), newName: '' },
                            }));
                          }}
                        >
                          <option value="new">+ Create new sprint</option>
                          {futureSprints.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                        {choice.mode === 'new' && (
                          <input
                            className="bl-modal__input"
                            value={choice.newName}
                            disabled={stage !== 'preview'}
                            placeholder="New sprint name"
                            onChange={(e) => setBucketChoices((prev) => ({
                              ...prev,
                              [sprintIndex]: { ...choice, newName: e.target.value },
                            }))}
                          />
                        )}
                      </div>
                    </div>
                    <div className="pe-bucket__issues-header">
                      <span className="pe-bucket__section-label">ISSUES IN THIS SPRINT</span>
                      <span>{rows.length} work item{rows.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="pe-issues">
                      {rows.map((issue, issueIndex) => {
                        const unusedLabels = spaceLabels.filter((l) => !issue.labels.includes(l.name));
                        return (
                          <div className="pe-issue" key={issue.tempId}>
                            <div className="pe-issue__topline">
                              <span className="pe-issue__eyebrow">ISSUE {issueIndex + 1}</span>
                              {stage === 'preview' && (
                                <button
                                  type="button"
                                  className="pe-issue__remove"
                                  aria-label={`Remove ${issue.title || 'issue'}`}
                                  onClick={() => removeIssue(issue.tempId)}
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                            <input
                              className="bl-modal__input pe-issue__title"
                              value={issue.title}
                              placeholder="Issue title"
                              disabled={stage !== 'preview'}
                              onChange={(e) => updateIssue(issue.tempId, { title: e.target.value })}
                            />
                            <textarea
                              className="bl-modal__input pe-issue__desc"
                              value={issue.description}
                              placeholder="Description — what needs to be done and why"
                              disabled={stage !== 'preview'}
                              onChange={(e) => updateIssue(issue.tempId, { description: e.target.value })}
                            />
                            <div className="pe-issue__meta">
                              <select
                                className="bl-modal__input pe-issue__type"
                                value={issue.issueType}
                                disabled={stage !== 'preview'}
                                title="story = user-facing, value-delivering work. task = internal/technical/enabling work. bug = fixing an existing defect."
                                onChange={(e) => updateIssue(issue.tempId, { issueType: e.target.value as IssueDraftDto['issueType'] })}
                              >
                                <option value="task">Task</option>
                                <option value="story">Story</option>
                                <option value="bug">Bug</option>
                              </select>
                              <input
                                className="bl-modal__input pe-issue__points"
                                type="number"
                                min="1"
                                placeholder="pts"
                                value={issue.estimateStoryPoints ?? ''}
                                disabled={stage !== 'preview'}
                                onChange={(e) => updatePoints(issue.tempId, e.target.value)}
                              />
                              <div className="pe-issue__labels">
                                {issue.labels.map((name) => {
                                  const { bg, text } = labelColor(name);
                                  return (
                                    <button
                                      key={name}
                                      type="button"
                                      className="pe-chip"
                                      disabled={stage !== 'preview'}
                                      style={{ background: bg, color: text, borderColor: 'transparent' }}
                                      onClick={() => toggleIssueLabel(issue.tempId, name)}
                                    >
                                      {name} ✕
                                    </button>
                                  );
                                })}
                                {stage === 'preview' && unusedLabels.length > 0 && (
                                  <button
                                    type="button"
                                    className="pe-chip pe-chip--add"
                                    onClick={() => setLabelPickerFor((current) => (current === issue.tempId ? null : issue.tempId))}
                                  >
                                    + label
                                  </button>
                                )}
                              </div>
                            </div>
                            {issue.estimateStoryPoints != null && issue.estimateRationale && (
                              <p className="pe-issue__rationale">Why {issue.estimateStoryPoints} pts: {issue.estimateRationale}</p>
                            )}
                            {labelPickerFor === issue.tempId && (
                              <div className="pe-issue__labels pe-issue__labels--picker">
                                {unusedLabels.map((label) => {
                                  const { bg, text } = labelColor(label.name);
                                  return (
                                    <button
                                      key={label.id}
                                      type="button"
                                      className="pe-chip"
                                      style={{ background: 'transparent', color: text, borderColor: bg }}
                                      onClick={() => toggleIssueLabel(issue.tempId, label.name)}
                                    >
                                      {label.name}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                            {issue.dependsOn.length > 0 && (
                              <span className="pe-issue__deps">
                                blocked by: {issue.dependsOn.map((id) => issues.find((i) => i.tempId === id)?.title || id).join(', ')}
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {stage === 'preview' && (
                        <button type="button" className="pe-add-issue" onClick={() => addIssue(sprintIndex)}>
                          + Add issue to this sprint
                        </button>
                      )}
                    </div>
                  </section>
                );
              })}

              {(stage === 'committing' || stage === 'error') && commitProgress && (
                <p className="pe-hint">Published issues: {commitProgress.created} of {commitProgress.total}</p>
              )}
              {commitError && <p className="pe-error">{commitError}</p>}
            </>
          )}
        </div>
        <div className="bl-modal__footer">
          {checkingForExisting && (
            <button type="button" className="bl-btn bl-btn--primary" disabled>Checking…</button>
          )}
          {!checkingForExisting && stage === 'input' && (
            <>
              <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="bl-btn bl-btn--primary"
                onClick={handleGenerate}
                disabled={!proposal.trim() || genLoading}
              >
                {genLoading ? (stageLabel ?? 'Generating…') : 'Generate plan'}
              </button>
            </>
          )}
          {stage === 'preview' && (
            <>
              <button type="button" className="bl-btn bl-btn--ghost" onClick={handleBack}>Back</button>
              <button
                type="button"
                className="bl-btn bl-btn--primary"
                onClick={handleCommit}
                disabled={!epicTitle.trim() || issues.length === 0 || hasEmptyTitle}
                title={hasEmptyTitle ? 'Every issue needs a title before creating' : undefined}
              >
                Approve &amp; create epic + {issues.length} issue{issues.length !== 1 ? 's' : ''}
              </button>
            </>
          )}
          {stage === 'committing' && (
            <button type="button" className="bl-btn bl-btn--primary" disabled>Publishing durably…</button>
          )}
          {stage === 'error' && (
            <>
              <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Close</button>
              <button type="button" className="bl-btn bl-btn--primary" onClick={handleRetry}>Resume publishing</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

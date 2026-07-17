import { useEffect, useMemo, useState } from 'react';
import type { Sprint } from '../types/sprint';
import type { Ticket } from '../types/ticket';
import './CompleteSprintModal.css';

export type IncompleteSprintDestination = 'backlog' | 'future_sprint' | 'new_sprint';

export interface CompleteSprintOptions {
  incompleteDestination?: IncompleteSprintDestination;
  moveToSprintId?: string;
  newSprintName?: string;
}

interface CompleteSprintModalProps {
  sprint: Sprint;
  tickets: Ticket[];
  futureSprints: Sprint[];
  onConfirm: (options?: CompleteSprintOptions) => void;
  onClose: () => void;
}

export function CompleteSprintModal({
  sprint,
  tickets,
  futureSprints,
  onConfirm,
  onClose,
}: CompleteSprintModalProps) {
  const incomplete = useMemo(
    () => tickets.filter((t) => t.sprintId === sprint.id && t.status !== 'done'),
    [tickets, sprint.id],
  );
  const doneCount = useMemo(
    () => tickets.filter((t) => t.sprintId === sprint.id && t.status === 'done').length,
    [tickets, sprint.id],
  );

  const [destination, setDestination] = useState<IncompleteSprintDestination>(
    futureSprints.length > 0 ? 'future_sprint' : 'backlog',
  );
  const [moveToSprintId, setMoveToSprintId] = useState(futureSprints[0]?.id ?? '');
  const [newSprintName, setNewSprintName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleConfirm() {
    if (incomplete.length === 0) {
      onConfirm();
      return;
    }
    if (destination === 'future_sprint') {
      if (!moveToSprintId) {
        alert('Select a future sprint for incomplete issues.');
        return;
      }
      onConfirm({ incompleteDestination: 'future_sprint', moveToSprintId });
      return;
    }
    if (destination === 'new_sprint') {
      onConfirm({
        incompleteDestination: 'new_sprint',
        newSprintName: newSprintName.trim() || undefined,
      });
      return;
    }
    onConfirm({ incompleteDestination: 'backlog' });
  }

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal csm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">Complete {sprint.name}</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body">
          <p className="csm-summary">
            <strong>{doneCount}</strong> issue{doneCount !== 1 ? 's' : ''} completed
            {incomplete.length > 0 && (
              <>
                {' · '}
                <strong>{incomplete.length}</strong> incomplete
              </>
            )}
          </p>

          {incomplete.length === 0 ? (
            <p className="csm-hint">All issues in this sprint are Done. Completing will close the sprint.</p>
          ) : (
            <>
              <p className="csm-hint">
                Choose where to move incomplete issues (same as Jira). Done issues stay on this sprint.
              </p>
              <div className="csm-options" role="radiogroup" aria-label="Move incomplete issues to">
                <label className={`csm-option${destination === 'backlog' ? ' is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="incomplete-dest"
                    checked={destination === 'backlog'}
                    onChange={() => setDestination('backlog')}
                  />
                  <span>
                    <strong>Backlog</strong>
                    <em>Remove incomplete issues from any sprint</em>
                  </span>
                </label>

                <label className={`csm-option${destination === 'future_sprint' ? ' is-selected' : ''}${futureSprints.length === 0 ? ' is-disabled' : ''}`}>
                  <input
                    type="radio"
                    name="incomplete-dest"
                    checked={destination === 'future_sprint'}
                    disabled={futureSprints.length === 0}
                    onChange={() => setDestination('future_sprint')}
                  />
                  <span>
                    <strong>Existing future sprint</strong>
                    <em>{futureSprints.length === 0 ? 'No upcoming sprints yet' : 'Move to a planned sprint'}</em>
                  </span>
                </label>
                {destination === 'future_sprint' && futureSprints.length > 0 && (
                  <select
                    className="bl-modal__input csm-select"
                    value={moveToSprintId}
                    onChange={(e) => setMoveToSprintId(e.target.value)}
                  >
                    {futureSprints.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                )}

                <label className={`csm-option${destination === 'new_sprint' ? ' is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="incomplete-dest"
                    checked={destination === 'new_sprint'}
                    onChange={() => setDestination('new_sprint')}
                  />
                  <span>
                    <strong>New sprint</strong>
                    <em>Create a sprint and move incomplete issues there</em>
                  </span>
                </label>
                {destination === 'new_sprint' && (
                  <input
                    className="bl-modal__input csm-select"
                    value={newSprintName}
                    onChange={(e) => setNewSprintName(e.target.value)}
                    placeholder="Sprint name (optional)"
                  />
                )}
              </div>
            </>
          )}
        </div>
        <div className="bl-modal__footer">
          <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="bl-btn bl-btn--primary" onClick={handleConfirm}>
            Complete sprint
          </button>
        </div>
      </div>
    </div>
  );
}

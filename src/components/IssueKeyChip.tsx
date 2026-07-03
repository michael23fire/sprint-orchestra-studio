import type { CSSProperties } from 'react';
import { ISSUE_TYPE_META } from '../types/ticket';

type IssueKeyChipProps = {
  issueKey: string;
  /** Board card hierarchy tweaks. */
  variant?: 'default' | 'parent' | 'sub' | 'header' | 'onEpic';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

export function IssueKeyChip({
  issueKey,
  variant = 'default',
  size = 'md',
  className = '',
}: IssueKeyChipProps) {
  return (
    <span
      className={`issue-key-chip issue-key-chip--size-${size} issue-key-chip--${variant} ${className}`.trim()}
      title={issueKey}
    >
      <span className="issue-key-chip__text">{issueKey}</span>
    </span>
  );
}

type EpicPillProps = {
  epicKey: string;
  className?: string;
};

/** Card / list: epic is visually distinct from the issue’s own key (label + rail + tint). */
export function EpicPill({ epicKey, className = '' }: EpicPillProps) {
  const epic = ISSUE_TYPE_META.epic;
  return (
    <div
      className={`epic-pill ${className}`.trim()}
      style={{ '--epic-accent': epic.color } as CSSProperties}
      title={`Epic ${epicKey}`}
    >
      <span className="epic-pill__rail" aria-hidden />
      <span className="epic-pill__icon" aria-hidden>
        {epic.icon}
      </span>
      <span className="epic-pill__word">Epic</span>
      <IssueKeyChip issueKey={epicKey} size="sm" variant="onEpic" className="epic-pill__keychip" />
    </div>
  );
}

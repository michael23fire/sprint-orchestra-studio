import { useCurrentUser } from '../context/UserContext';
import { initialsForPerson, resolveAssigneeAvatarBackground } from '../utils/assigneeDisplay';
import './AssigneeAvatar.css';

export interface AssigneeAvatarProps {
  name: string;
  size?: 'card' | 'toolbar';
  /** Use when the label is already visible (e.g. overflow list row). */
  showHoverTooltip?: boolean;
  className?: string;
  isActive?: boolean;
  as?: 'button' | 'div';
  onClick?: () => void;
  type?: 'button' | 'submit';
  'aria-pressed'?: boolean;
  'aria-label'?: string;
}

export function AssigneeAvatar({
  name,
  size = 'card',
  showHoverTooltip = true,
  className = '',
  isActive,
  as = 'div',
  onClick,
  type = 'button',
  ...aria
}: AssigneeAvatarProps) {
  const { users } = useCurrentUser();
  const initials = initialsForPerson(name);
  const background = resolveAssigneeAvatarBackground(name, users);

  const cls = [
    'assignee-avatar',
    size === 'toolbar' ? 'assignee-avatar--toolbar' : 'assignee-avatar--card',
    isActive ? 'assignee-avatar--active' : '',
    !showHoverTooltip ? 'assignee-avatar--no-hover' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const glyph = <span className="assignee-avatar__glyph" aria-hidden>{initials}</span>;

  const tooltip = showHoverTooltip ? (
    <span className="assignee-avatar__popup" role="tooltip">
      {name}
    </span>
  ) : null;

  const hostClass = [
    'assignee-avatar-host',
    showHoverTooltip ? '' : 'assignee-avatar-host--no-popup',
  ]
    .filter(Boolean)
    .join(' ');

  if (as === 'button') {
    return (
      <span className={hostClass}>
        <button
          type={type}
          className={cls}
          style={{ background }}
          title={name}
          onClick={onClick}
          {...aria}
        >
          {glyph}
        </button>
        {tooltip}
      </span>
    );
  }

  return (
    <span className={hostClass}>
      <div className={cls} style={{ background }} title={name} aria-label={name}>
        {glyph}
      </div>
      {tooltip}
    </span>
  );
}

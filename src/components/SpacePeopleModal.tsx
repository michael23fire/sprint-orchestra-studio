import { useMemo, useState } from 'react';
import type { Space } from '../types/space';
import { useCurrentUser } from '../context/UserContext';

interface Props {
  space: Space;
  onClose: () => void;
}

export function SpacePeopleModal({ space, onClose }: Props) {
  const { users } = useCurrentUser();
  const [query, setQuery] = useState('');

  const admin = users.find((u) => u.id === space.ownerId);
  const directMembers = users.filter((u) => space.members.includes(u.id));

  const effectiveMemberIds = useMemo(() => {
    const set = new Set<string>(space.members);
    for (const g of space.groups) {
      for (const id of g.memberIds) set.add(id);
    }
    return Array.from(set);
  }, [space.members, space.groups]);

  const effectiveMembers = users.filter((u) => effectiveMemberIds.includes(u.id));
  const q = query.trim().toLowerCase();
  const filtered = q
    ? effectiveMembers.filter((u) => u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
    : effectiveMembers;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal spm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">People in {space.name}</h2>
          <button type="button" className="modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="modal__form">
          <div className="spm-summary">
            <span className="spm-chip">Admin: {admin?.name ?? 'Unknown'}</span>
            <span className="spm-chip">Direct members: {directMembers.length}</span>
            <span className="spm-chip">Groups: {space.groups.length}</span>
            <span className="spm-chip">Total access: {effectiveMembers.length}</span>
          </div>

          <input
            type="search"
            className="modal__input"
            placeholder="Search members..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />

          <div className="spm-list">
            {filtered.length === 0 && (
              <p className="spm-empty">No members found.</p>
            )}
            {filtered.map((u) => (
              <div key={u.id} className="spm-item">
                <span className="spm-avatar" style={{ background: u.avatarColor }}>
                  {u.name.charAt(0)}
                </span>
                <div className="spm-meta">
                  <span className="spm-name">{u.name}</span>
                  <span className="spm-username">@{u.username}</span>
                </div>
                {admin?.id === u.id && <span className="spm-role">Admin</span>}
              </div>
            ))}
          </div>

          {space.groups.length > 0 && (
            <div className="spm-groups">
              <h4 className="spm-groups__title">Access Groups</h4>
              <div className="spm-groups__list">
                {space.groups.map((g) => (
                  <span key={g.id} className="spm-group-tag">{g.name} ({g.memberIds.length})</span>
                ))}
              </div>
            </div>
          )}

          <div className="modal__footer">
            <button type="button" className="modal__btn modal__btn--confirm" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

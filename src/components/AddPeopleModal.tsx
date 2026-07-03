import { useState, useMemo, useEffect } from 'react';
import { useSpaces } from '../context/SpaceContext';
import { useCurrentUser } from '../context/UserContext';
import { isSpaceOwner } from '../types/space';
import { groupApi } from '../api';
import type { GroupDto } from '../api';

interface Props {
  spaceId: string;
  onClose: () => void;
}

export function AddPeopleModal({ spaceId, onClose }: Props) {
  const { spaces, addMember, removeMember, addGroup, removeGroup, hydrateSpace } = useSpaces();
  const { currentUser, apiReady, users } = useCurrentUser();
  const space = spaces.find((s) => s.id === spaceId);
  const [search, setSearch] = useState('');
  const [allGroups, setAllGroups] = useState<GroupDto[]>([]);
  const [tab, setTab] = useState<'all' | 'people' | 'groups'>('all');

  useEffect(() => {
    if (apiReady) {
      groupApi.getAll().then(setAllGroups).catch(() => {});
    }
  }, [apiReady]);

  useEffect(() => {
    void hydrateSpace(spaceId);
  }, [spaceId, hydrateSpace]);

  if (!space) return null;

  const isMember = (userId: string) => space.members.includes(userId);
  const isGroupAdded = (groupId: string) => space.groups.some((g) => g.id === groupId);
  const isSpaceAdmin = (userId: string) => space.ownerId === userId;
  const canManageMembers = isSpaceOwner(space, currentUser.id);

  const toggleUser = (userId: string) => {
    if (!canManageMembers) return;
    if (isSpaceAdmin(userId) && isMember(userId)) {
      alert('Space admin cannot remove themselves.');
      return;
    }
    if (isMember(userId)) {
      removeMember(space.id, userId);
    } else {
      addMember(space.id, userId);
    }
  };

  const toggleGroup = (groupId: string) => {
    if (!canManageMembers) return;
    if (isGroupAdded(groupId)) {
      removeGroup(space.id, groupId);
    } else {
      addGroup(space.id, groupId);
    }
  };

  const q = search.toLowerCase().trim();

  const filteredUsers = useMemo(() => {
    if (tab === 'groups') return [];
    if (!q) return users;
    return users.filter((u) => u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
  }, [q, tab, users]);

  const filteredGroups = useMemo(() => {
    if (tab === 'people') return [];
    if (!q) return allGroups;
    return allGroups.filter((g) => g.name.toLowerCase().includes(q));
  }, [search, allGroups, tab]);

  const memberCount = space.members.length;
  const groupCount = space.groups.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">
            {canManageMembers ? 'Manage People' : 'People'} — {space.name}
          </h2>
          <button type="button" className="modal__close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal__form">
          <input
            type="search"
            className="modal__input"
            placeholder="Search people & groups..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />

          <div className="people-tabs">
            <button type="button" className={`people-tab ${tab === 'all' ? 'people-tab--active' : ''}`} onClick={() => setTab('all')}>All</button>
            <button type="button" className={`people-tab ${tab === 'people' ? 'people-tab--active' : ''}`} onClick={() => setTab('people')}>People ({memberCount})</button>
            <button type="button" className={`people-tab ${tab === 'groups' ? 'people-tab--active' : ''}`} onClick={() => setTab('groups')}>Groups ({groupCount})</button>
          </div>

          <div className="people-list">
            {filteredGroups.length === 0 && filteredUsers.length === 0 && (
              <p style={{ textAlign: 'center', color: '#94a3b8', padding: '1rem 0', margin: 0 }}>
                No results for "{search}"
              </p>
            )}

            {filteredGroups.map((group) => {
              const active = isGroupAdded(String(group.id));
              const RowTag = canManageMembers ? 'button' : 'div';
              return (
                <RowTag
                  key={`g-${group.id}`}
                  type={canManageMembers ? 'button' : undefined}
                  className={`people-list__item ${active ? 'people-list__item--active' : ''} ${!canManageMembers ? 'people-list__item--readonly' : ''}`}
                  onClick={canManageMembers ? () => toggleGroup(String(group.id)) : undefined}
                >
                  <span className="people-list__group-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </span>
                  <span className="people-list__name">
                    {group.name}
                    <span className="people-list__group-count"> · {group.members?.length ?? 0} members</span>
                  </span>
                  <span className="people-list__badge">
                    {canManageMembers
                      ? (active ? 'Remove' : 'Add Group')
                      : (active ? 'Added' : '')}
                  </span>
                </RowTag>
              );
            })}

            {filteredGroups.length > 0 && filteredUsers.length > 0 && (
              <div className="people-list__divider" />
            )}

            {filteredUsers.map((user) => {
              const active = isMember(user.id);
              const owner = isSpaceAdmin(user.id);
              const ownerLocked = owner && active;
              const RowTag = canManageMembers ? 'button' : 'div';
              return (
                <RowTag
                  key={`u-${user.id}`}
                  type={canManageMembers ? 'button' : undefined}
                  className={`people-list__item ${active ? 'people-list__item--active' : ''} ${!canManageMembers ? 'people-list__item--readonly' : ''}`}
                  onClick={canManageMembers ? () => toggleUser(user.id) : undefined}
                >
                  <span
                    className="people-list__avatar"
                    style={{ background: user.avatarColor }}
                  >
                    {user.name.charAt(0)}
                  </span>
                  <span className="people-list__name">{user.name}</span>
                  <span className="people-list__badge">
                    {ownerLocked
                      ? 'Owner'
                      : canManageMembers
                        ? (active ? 'Remove' : 'Add')
                        : (active ? 'Member' : '')}
                  </span>
                </RowTag>
              );
            })}
          </div>
          <div className="modal__footer">
            <button type="button" className="modal__btn modal__btn--confirm" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

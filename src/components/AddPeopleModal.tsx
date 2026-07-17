import { useState, useEffect } from 'react';
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
  const [pendingGroupIds, setPendingGroupIds] = useState<Set<string>>(() => new Set());

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
  const groupNamesForUser = (userId: string) =>
    space.groups.filter((group) => group.memberIds.includes(userId)).map((group) => group.name);
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

  const toggleGroup = async (groupId: string) => {
    // Serialize group mutations for this modal. A second add/remove while the
    // first request is hydrating could otherwise apply stale group data last.
    if (!canManageMembers || pendingGroupIds.size > 0) return;
    setPendingGroupIds((prev) => new Set(prev).add(groupId));
    try {
      if (isGroupAdded(groupId)) {
        await removeGroup(space.id, groupId);
      } else {
        await addGroup(space.id, groupId);
      }
    } finally {
      setPendingGroupIds((prev) => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    }
  };

  const q = search.toLowerCase().trim();

  const filteredUsers = tab === 'groups'
    ? []
    : q
      ? users.filter((u) => u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
      : users;

  const filteredGroups = tab === 'people'
    ? []
    : q
      ? allGroups.filter((g) => g.name.toLowerCase().includes(q))
      : allGroups;

  const effectiveMemberIds = new Set([
    ...space.members,
    ...space.groups.flatMap((group) => group.memberIds),
  ]);
  const memberCount = effectiveMemberIds.size;
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
              const pending = pendingGroupIds.has(String(group.id));
              const anotherGroupPending = pendingGroupIds.size > 0 && !pending;
              const RowTag = canManageMembers ? 'button' : 'div';
              return (
                <RowTag
                  key={`g-${group.id}`}
                  type={canManageMembers ? 'button' : undefined}
                  disabled={canManageMembers ? pending || anotherGroupPending : undefined}
                  className={`people-list__item ${active ? 'people-list__item--active' : ''} ${!canManageMembers ? 'people-list__item--readonly' : ''}`}
                  onClick={canManageMembers ? () => void toggleGroup(String(group.id)) : undefined}
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
                      ? (pending ? 'Saving…' : active ? 'Remove' : 'Add Group')
                      : (active ? 'Added' : '')}
                  </span>
                </RowTag>
              );
            })}

            {filteredGroups.length > 0 && filteredUsers.length > 0 && (
              <div className="people-list__divider" />
            )}

            {filteredUsers.map((user) => {
              const direct = isMember(user.id);
              const viaGroups = groupNamesForUser(user.id);
              const viaGroup = viaGroups.length > 0;
              const active = direct || viaGroup;
              const owner = isSpaceAdmin(user.id);
              const ownerLocked = owner && direct;
              // Group-only access must be managed by removing the group (or the
              // person from that group), not by pretending this is a direct member.
              const canToggleDirect = canManageMembers && !ownerLocked && (direct || !viaGroup);
              const RowTag = canToggleDirect ? 'button' : 'div';
              return (
                <RowTag
                  key={`u-${user.id}`}
                  type={canToggleDirect ? 'button' : undefined}
                  className={`people-list__item ${active ? 'people-list__item--active' : ''} ${!canToggleDirect ? 'people-list__item--readonly' : ''}`}
                  onClick={canToggleDirect ? () => toggleUser(user.id) : undefined}
                >
                  <span
                    className="people-list__avatar"
                    style={{ background: user.avatarColor }}
                  >
                    {user.name.charAt(0)}
                  </span>
                  <span className="people-list__name">{user.name}</span>
                  <span
                    className={`people-list__badge${viaGroup && !ownerLocked ? ' people-list__badge--inherited' : ''}`}
                    title={viaGroup ? `Access via ${viaGroups.join(', ')}` : undefined}
                  >
                    {ownerLocked
                      ? 'Owner'
                      : direct && viaGroup
                        ? 'Direct + group'
                        : viaGroup
                          ? 'Via group'
                          : canManageMembers
                            ? (direct ? 'Remove' : 'Add')
                            : (direct ? 'Member' : '')}
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

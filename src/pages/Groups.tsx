import { useState, useEffect, useCallback } from 'react';
import { groupApi } from '../api';
import type { GroupDto } from '../api';
import { useCurrentUser } from '../context/UserContext';
import './Groups.css';

export function Groups() {
  const { currentUser, apiReady, users } = useCurrentUser();
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [memberSearch, setMemberSearch] = useState('');

  const fetchGroups = useCallback(() => {
    if (!apiReady) return;
    groupApi.getAll().then(setGroups).catch(() => {});
  }, [apiReady]);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  function handleCreate() {
    if (!newName.trim()) return;
    groupApi.create({ name: newName.trim(), description: newDesc.trim() || undefined }, Number(currentUser.id))
      .then(() => {
        fetchGroups();
        setShowCreate(false);
        setNewName('');
        setNewDesc('');
      })
      .catch(() => {});
  }

  function handleAddMember(groupId: number, userId: number) {
    groupApi.addMember(groupId, userId).then(() => fetchGroups()).catch((e) => {
      alert(e instanceof Error ? e.message : 'Failed to add member');
    });
  }

  function handleRemoveMember(groupId: number, userId: number) {
    groupApi.removeMember(groupId, userId).then(() => fetchGroups()).catch((e) => {
      alert(e instanceof Error ? e.message : 'Failed to remove member');
    });
  }

  function handleDelete(groupId: number) {
    if (!confirm('Delete this group? Members will be removed from all spaces using this group.')) return;
    groupApi.delete(groupId).then(() => fetchGroups()).catch(() => {});
  }

  const expandedGroup = expandedId != null ? groups.find((g) => g.id === expandedId) : null;
  const expandedMemberIds = new Set(expandedGroup?.members?.map((m) => m.id) ?? []);
  const filteredUsers = users.filter((u) => {
    const q = memberSearch.toLowerCase().trim();
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
  });

  return (
    <div className="groups-page">
      <div className="groups-header">
        <h1 className="groups-header__title">Groups</h1>
        <button type="button" className="groups-header__create" onClick={() => setShowCreate(true)}>
          + Create Group
        </button>
      </div>

      {showCreate && (
        <div className="groups-create-card">
          <input
            className="groups-input"
            placeholder="Group name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <input
            className="groups-input"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <div className="groups-create-actions">
            <button type="button" className="groups-btn groups-btn--primary" onClick={handleCreate} disabled={!newName.trim()}>Create</button>
            <button type="button" className="groups-btn groups-btn--ghost" onClick={() => { setShowCreate(false); setNewName(''); setNewDesc(''); }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="groups-list">
        {groups.length === 0 && !showCreate && (
          <p className="groups-empty">No groups yet. Create one to manage team memberships.</p>
        )}
        {groups.map((g) => {
          const isOwner = g.ownerId === Number(currentUser.id);
          const isExpanded = expandedId === g.id;
          return (
            <div key={g.id} className={`groups-card ${isExpanded ? 'groups-card--expanded' : ''}`}>
              <div className="groups-card__header" onClick={() => { setExpandedId(isExpanded ? null : g.id); setMemberSearch(''); }}>
                <div className="groups-card__icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div className="groups-card__info">
                  <span className="groups-card__name">{g.name}</span>
                  {g.description && <span className="groups-card__desc">{g.description}</span>}
                </div>
                <span className="groups-card__count">{g.members?.length ?? 0} members</span>
                <div className="groups-card__avatars">
                  {(g.members ?? []).slice(0, 4).map((m) => (
                    <span key={m.id} className="groups-card__avatar" style={{ background: m.avatarColor }} title={m.name}>
                      {m.name.charAt(0)}
                    </span>
                  ))}
                </div>
                {isOwner && (
                  <button type="button" className="groups-card__delete" title="Delete group" onClick={(e) => { e.stopPropagation(); handleDelete(g.id); }}>✕</button>
                )}
              </div>

              {isExpanded && (
                <div className="groups-card__body">
                  <input
                    type="search"
                    className="groups-input"
                    placeholder="Search people to add…"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    autoFocus
                  />
                  <div className="groups-member-list">
                    {filteredUsers.map((u) => {
                      const isMem = expandedMemberIds.has(Number(u.id));
                      return (
                        <div key={u.id} className={`groups-member-item ${isMem ? 'groups-member-item--active' : ''}`}>
                          <span className="groups-member-avatar" style={{ background: u.avatarColor }}>{u.name.charAt(0)}</span>
                          <span className="groups-member-name">{u.name}</span>
                          <button
                            type="button"
                            className={`groups-member-btn ${isMem ? 'groups-member-btn--remove' : ''}`}
                            onClick={() => isMem ? handleRemoveMember(g.id, Number(u.id)) : handleAddMember(g.id, Number(u.id))}
                          >
                            {isMem ? 'Remove' : 'Add'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

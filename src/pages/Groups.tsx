import { useState, useEffect, useCallback } from 'react';
import { groupApi } from '../api';
import type { GroupDto } from '../api';
import { useCurrentUser } from '../context/UserContext';
import './Groups.css';

function isGroupAdmin(group: GroupDto, userId: number): boolean {
  return group.ownerId === userId;
}

export function Groups() {
  const { currentUser, apiReady, users } = useCurrentUser();
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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

  function startEdit(g: GroupDto) {
    setEditingId(g.id);
    setEditName(g.name);
    setEditDesc(g.description ?? '');
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName('');
    setEditDesc('');
    setEditError(null);
  }

  function handleSaveEdit(groupId: number) {
    const name = editName.trim();
    if (!name) {
      setEditError('Group name is required.');
      return;
    }
    setEditSaving(true);
    setEditError(null);
    groupApi.update(groupId, { name, description: editDesc.trim() })
      .then(() => {
        fetchGroups();
        cancelEdit();
      })
      .catch((e) => {
        setEditError(e instanceof Error ? e.message : 'Failed to update group');
      })
      .finally(() => setEditSaving(false));
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
    groupApi.delete(groupId).then(() => {
      if (editingId === groupId) cancelEdit();
      fetchGroups();
    }).catch((e) => {
      alert(e instanceof Error ? e.message : 'Failed to delete group');
    });
  }

  const expandedGroup = expandedId != null ? groups.find((g) => g.id === expandedId) : null;
  const canManageExpanded = expandedGroup != null && isGroupAdmin(expandedGroup, Number(currentUser.id));
  const expandedMemberIds = new Set(expandedGroup?.members?.map((m) => m.id) ?? []);

  const filteredUsers = users.filter((u) => {
    const q = memberSearch.toLowerCase().trim();
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
  });

  /** Non-admins only see current members (read-only). Admins see everyone to Add/Remove. */
  const peopleRows = canManageExpanded
    ? filteredUsers
    : filteredUsers.filter((u) => expandedMemberIds.has(Number(u.id)));

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
          const canManage = isGroupAdmin(g, Number(currentUser.id));
          const isExpanded = expandedId === g.id;
          return (
            <div key={g.id} className={`groups-card ${isExpanded ? 'groups-card--expanded' : ''}`}>
              <div
                className="groups-card__header"
                onClick={() => {
                  if (editingId === g.id) return;
                  setExpandedId(isExpanded ? null : g.id);
                  setMemberSearch('');
                  if (editingId != null && editingId !== g.id) cancelEdit();
                }}
              >
                <div className="groups-card__icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div className="groups-card__info">
                  {editingId === g.id ? (
                    <div className="groups-edit-fields" onClick={(e) => e.stopPropagation()}>
                      <label className="groups-edit-field">
                        <span className="groups-edit-label">Group name</span>
                        <input
                          className="groups-input"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="e.g. Platform team"
                          autoFocus
                        />
                      </label>
                      <label className="groups-edit-field">
                        <span className="groups-edit-label">Description</span>
                        <input
                          className="groups-input"
                          value={editDesc}
                          onChange={(e) => setEditDesc(e.target.value)}
                          placeholder="Optional short description"
                        />
                      </label>
                      {editError && <p className="groups-edit-error">{editError}</p>}
                      <div className="groups-create-actions">
                        <button
                          type="button"
                          className="groups-btn groups-btn--primary"
                          disabled={editSaving || !editName.trim()}
                          onClick={() => handleSaveEdit(g.id)}
                        >
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          className="groups-btn groups-btn--ghost"
                          disabled={editSaving}
                          onClick={cancelEdit}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="groups-card__name">
                        {g.name}
                        {canManage && <span className="groups-card__admin-badge">Admin</span>}
                      </span>
                      {g.description && <span className="groups-card__desc">{g.description}</span>}
                    </>
                  )}
                </div>
                {editingId !== g.id && (
                  <>
                    <span className="groups-card__count">{g.members?.length ?? 0} members</span>
                    <div className="groups-card__avatars">
                      {(g.members ?? []).slice(0, 4).map((m) => (
                        <span key={m.id} className="groups-card__avatar" style={{ background: m.avatarColor }} title={m.name}>
                          {m.name.charAt(0)}
                        </span>
                      ))}
                    </div>
                    <div className="groups-card__actions" aria-hidden={!canManage}>
                      {canManage ? (
                        <>
                          <button
                            type="button"
                            className="groups-card__edit"
                            title="Edit name and description"
                            aria-label="Edit name and description"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedId(g.id);
                              startEdit(g);
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>
                          <button type="button" className="groups-card__delete" title="Delete group" onClick={(e) => { e.stopPropagation(); handleDelete(g.id); }}>✕</button>
                        </>
                      ) : null}
                    </div>
                  </>
                )}
              </div>

              {isExpanded && (
                <div className="groups-card__body">
                  {!canManage && (
                    <p className="groups-readonly-hint">
                      Only the group admin can add or remove members.
                    </p>
                  )}
                  <input
                    type="search"
                    className="groups-input"
                    placeholder={canManage ? 'Search people to add…' : 'Search members…'}
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    autoFocus
                  />
                  <div className="groups-member-list">
                    {peopleRows.length === 0 && (
                      <p className="groups-empty" style={{ padding: '0.75rem 0' }}>
                        {canManage ? 'No people match your search.' : 'No members yet.'}
                      </p>
                    )}
                    {peopleRows.map((u) => {
                      const uid = Number(u.id);
                      const isMem = expandedMemberIds.has(uid);
                      const isOwnerUser = g.ownerId === uid;
                      return (
                        <div key={u.id} className={`groups-member-item ${isMem ? 'groups-member-item--active' : ''}`}>
                          <span className="groups-member-avatar" style={{ background: u.avatarColor }}>{u.name.charAt(0)}</span>
                          <span className="groups-member-name">
                            {u.name}
                            {isOwnerUser && <span className="groups-member-role">Admin</span>}
                          </span>
                          {canManage && !isOwnerUser && (
                            <button
                              type="button"
                              className={`groups-member-btn ${isMem ? 'groups-member-btn--remove' : ''}`}
                              onClick={() => isMem ? handleRemoveMember(g.id, uid) : handleAddMember(g.id, uid)}
                            >
                              {isMem ? 'Remove' : 'Add'}
                            </button>
                          )}
                          {canManage && isOwnerUser && (
                            <span className="groups-member-locked">Owner</span>
                          )}
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

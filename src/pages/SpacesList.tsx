import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSpaces } from '../context/SpaceContext';
import { CreateSpaceModal } from '../components/CreateSpaceModal';
import { useCurrentUser } from '../context/UserContext';
import { SpacePeopleModal } from '../components/SpacePeopleModal';
import './SpacesList.css';

export function SpacesList() {
  const navigate = useNavigate();
  const { spaces, setCurrentSpace, hydrateSpace } = useSpaces();
  const { users } = useCurrentUser();
  const [showCreate, setShowCreate] = useState(false);
  const [peopleSpaceId, setPeopleSpaceId] = useState<string | null>(null);
  const peopleSpace = peopleSpaceId ? spaces.find((s) => s.id === peopleSpaceId) ?? null : null;

  useEffect(() => {
    if (!peopleSpaceId) return;
    void hydrateSpace(peopleSpaceId);
  }, [peopleSpaceId, hydrateSpace]);

  function handleSelectSpace(space: typeof spaces[number]) {
    setCurrentSpace(space);
    navigate('/board');
  }

  return (
    <div className="sl-page">
      <div className="sl-header">
        <h1 className="sl-header__title">Spaces</h1>
        <button
          type="button"
          className="sl-header__create"
          onClick={() => setShowCreate(true)}
        >
          + Create Space
        </button>
      </div>

      <div className="sl-grid">
        {spaces.map((space) => {
          const members = users.filter((u) => space.members.includes(u.id));
          const admin = users.find((u) => u.id === space.ownerId);
          return (
            <button
              key={space.id}
              type="button"
              className="sl-card"
              onClick={() => handleSelectSpace(space)}
            >
              <div className="sl-card__icon" style={{ background: space.color }}>
                {space.name.charAt(0).toUpperCase()}
              </div>
              <div className="sl-card__info">
                <div className="sl-card__name">{space.name}</div>
                <div className="sl-card__key">{space.key}</div>
                <div className="sl-card__key">Admin: {admin?.name ?? 'Unknown'}</div>
                <button
                  type="button"
                  className="sl-card__key"
                  onClick={(e) => { e.stopPropagation(); setPeopleSpaceId(space.id); }}
                >
                  View all members
                </button>
              </div>
              <div className="sl-card__members">
                {members.slice(0, 3).map((u) => (
                  <span
                    key={u.id}
                    className="sl-card__avatar"
                    style={{ background: u.avatarColor }}
                    title={u.name}
                  >
                    {u.name.charAt(0)}
                  </span>
                ))}
                {members.length > 3 && (
                  <span className="sl-card__avatar sl-card__avatar--more">
                    +{members.length - 3}
                  </span>
                )}
                {members.length === 0 && (
                  <span className="sl-card__no-members">No members</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {showCreate && <CreateSpaceModal onClose={() => setShowCreate(false)} />}
      {peopleSpace && (
        <SpacePeopleModal
          space={peopleSpace}
          onClose={() => setPeopleSpaceId(null)}
        />
      )}
    </div>
  );
}

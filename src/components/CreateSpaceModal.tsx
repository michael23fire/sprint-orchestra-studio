import { useState } from 'react';
import { useSpaces } from '../context/SpaceContext';

interface Props {
  onClose: () => void;
}

export function CreateSpaceModal({ onClose }: Props) {
  const { createSpace, setCurrentSpace } = useSpaces();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');

  const handleNameChange = (val: string) => {
    setName(val);
    if (!key || key === deriveKey(name)) {
      setKey(deriveKey(val));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !key.trim()) return;
    const space = createSpace(name.trim(), key.trim());
    setCurrentSpace(space);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">Create Space</h2>
          <button type="button" className="modal__close" onClick={onClose}>
            ✕
          </button>
        </div>
        <form className="modal__form" onSubmit={handleSubmit}>
          <div className="modal__field">
            <label className="modal__label">
              Space name <span className="modal__required">*</span>
            </label>
            <input
              className="modal__input"
              placeholder="e.g. Mobile App"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              autoFocus
            />
          </div>
          <div className="modal__field">
            <label className="modal__label">
              Key <span className="modal__required">*</span>
            </label>
            <input
              className="modal__input"
              placeholder="e.g. MOB"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              maxLength={6}
            />
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
              Used as ticket prefix, e.g. {key || 'KEY'}-1
            </span>
          </div>
          <div className="modal__footer">
            <button type="button" className="modal__btn modal__btn--cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="modal__btn modal__btn--confirm"
              disabled={!name.trim() || !key.trim()}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function deriveKey(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 4);
}

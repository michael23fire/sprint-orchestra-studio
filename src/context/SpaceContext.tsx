import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { Space } from '../types/space';
import { SPACE_COLORS, isSpaceOwner } from '../types/space';
import { spaceApi } from '../api';
import type { SpaceDto } from '../api';
import { useCurrentUser } from './UserContext';

function dtoToSpace(dto: SpaceDto): Space {
  return {
    id: String(dto.id),
    name: dto.name,
    key: dto.key,
    color: dto.color ?? SPACE_COLORS[0],
    ownerId: dto.ownerId != null ? String(dto.ownerId) : undefined,
    members: dto.members?.map((m) => String(m.id)) ?? [],
    groups: dto.groups?.map((g) => ({
      id: String(g.id),
      name: g.name,
      memberIds: g.members?.map((m) => String(m.id)) ?? [],
    })) ?? [],
  };
}

const STORAGE_KEY = 'jira_current_space_id';

const EMPTY_SPACE: Space = {
  id: '',
  name: '',
  key: '',
  color: SPACE_COLORS[0],
  ownerId: undefined,
  members: [],
  groups: [],
};

interface SpaceContextValue {
  spaces: Space[];
  currentSpace: Space;
  setCurrentSpace: (space: Space) => void;
  /** Loads full space (including linked groups) from the API and merges into state. */
  hydrateSpace: (spaceId: string) => Promise<void>;
  createSpace: (name: string, key: string) => Space;
  addMember: (spaceId: string, userId: string) => void;
  removeMember: (spaceId: string, userId: string) => void;
  addGroup: (spaceId: string, groupId: string) => Promise<boolean>;
  removeGroup: (spaceId: string, groupId: string) => Promise<boolean>;
  refreshSpaces: () => void;
}

const SpaceContext = createContext<SpaceContextValue | null>(null);

export function SpaceProvider({ children }: { children: React.ReactNode }) {
  const { currentUser, apiReady, users } = useCurrentUser();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [currentSpace, setCurrentSpace] = useState<Space>(EMPTY_SPACE);

  function pickCurrentSpace(mapped: Space[]): Space {
    if (mapped.length === 0) return EMPTY_SPACE;
    const savedId = localStorage.getItem(STORAGE_KEY);
    if (savedId) {
      const found = mapped.find((s) => s.id === savedId);
      if (found) return found;
    }
    return mapped[0];
  }

  const mergeSpaceFromDto = useCallback((dto: SpaceDto) => {
    const full = dtoToSpace(dto);
    setSpaces((prev) => prev.map((s) => (s.id === full.id ? full : s)));
    setCurrentSpace((prev) => (prev.id === full.id ? full : prev));
  }, []);

  const hydrateSpace = useCallback(
    async (spaceId: string) => {
      const n = Number(spaceId);
      if (!Number.isFinite(n) || n <= 0) return;
      try {
        const dto = await spaceApi.getById(n);
        mergeSpaceFromDto(dto);
      } catch {
        /* ignore */
      }
    },
    [mergeSpaceFromDto],
  );

  const setCurrentSpaceAndPersist = useCallback((space: Space) => {
    localStorage.setItem(STORAGE_KEY, space.id);
    setCurrentSpace(space);
    // Space list rows are intentionally lean (groups omitted). Always hydrate
    // the selected space so inherited membership is available to every page.
    void hydrateSpace(space.id);
  }, [hydrateSpace]);

  const fetchSpaces = useCallback(() => {
    const uid = Number(currentUser.id);
    return spaceApi.getAll(uid)
      .then((dtos) => dtos.map(dtoToSpace));
  }, [currentUser.id]);

  const refreshSpaces = useCallback(() => {
    fetchSpaces()
      .then((mapped) => {
        // The list endpoint intentionally returns groups: []. Do not let a
        // general list refresh erase group links already hydrated for a space.
        const mappedWithGroups = mapped.map((next) => {
          const existing = spaces.find((space) => space.id === next.id);
          return existing ? { ...next, groups: existing.groups } : next;
        });
        setSpaces(mappedWithGroups);
        setCurrentSpace((prev) => {
          const found = mappedWithGroups.find((s) => s.id === prev.id);
          return found ?? pickCurrentSpace(mappedWithGroups);
        });
        const savedId = localStorage.getItem(STORAGE_KEY);
        const resolved =
          (savedId ? mappedWithGroups.find((s) => s.id === savedId) : undefined) ?? pickCurrentSpace(mappedWithGroups);
        if (resolved.id) {
          const idNum = Number(resolved.id);
          if (Number.isFinite(idNum) && idNum > 0) {
            spaceApi.getById(idNum).then(mergeSpaceFromDto).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }, [fetchSpaces, mergeSpaceFromDto, spaces]);

  useEffect(() => {
    if (!apiReady) return;

    const uid = Number(currentUser.id);
    spaceApi.getAll(uid)
      .then(async (dtos) => {
        if (dtos.length === 0) {
          const created = await spaceApi.create(
            { name: 'Agentic AI Sprint', key: 'SCRUM', color: SPACE_COLORS[0] },
            uid,
          );
          for (const u of users) {
            if (String(u.id) !== String(currentUser.id)) {
              await spaceApi.addMember(created.id, { userId: Number(u.id) }).catch(() => {});
            }
          }
          dtos = await spaceApi.getAll(uid);
        }
        const mapped = dtos.map(dtoToSpace);
        setSpaces(mapped);
        const selected = pickCurrentSpace(mapped);
        if (selected.id) localStorage.setItem(STORAGE_KEY, selected.id);
        setCurrentSpace(selected);
        const idNum = Number(selected.id);
        if (Number.isFinite(idNum) && idNum > 0) {
          spaceApi.getById(idNum).then(mergeSpaceFromDto).catch(() => {});
        }
      })
      .catch(() => {});
  }, [apiReady, currentUser.id, users, mergeSpaceFromDto]);

  const createSpace = useCallback((name: string, key: string): Space => {
    const colorIndex = spaces.length % SPACE_COLORS.length;
    const localSpace: Space = {
      id: `space-${Date.now()}`,
      name,
      key: key.toUpperCase(),
      color: SPACE_COLORS[colorIndex],
      ownerId: currentUser.id,
      members: [],
      groups: [],
    };

    if (apiReady) {
      spaceApi.create({ name, key: key.toUpperCase(), color: SPACE_COLORS[colorIndex] }, Number(currentUser.id))
        .then((dto) => {
          const created = dtoToSpace(dto);
          setSpaces((prev) => {
            const without = prev.filter((s) => s.id !== localSpace.id);
            return [...without, created];
          });
          setCurrentSpace((prev) => prev.id === localSpace.id ? created : prev);
        })
        .catch(() => {});
    }

    setSpaces((prev) => [...prev, localSpace]);
    return localSpace;
  }, [spaces.length, apiReady, currentUser.id]);

  const addMember = useCallback((spaceId: string, userId: string) => {
    const space = spaces.find((s) => s.id === spaceId);
    if (!space || !isSpaceOwner(space, currentUser.id)) return;

    setSpaces((prev) =>
      prev.map((s) =>
        s.id === spaceId && !s.members.includes(userId)
          ? { ...s, members: [...s.members, userId] }
          : s,
      ),
    );
    setCurrentSpace((prev) =>
      prev.id === spaceId && !prev.members.includes(userId)
        ? { ...prev, members: [...prev.members, userId] }
        : prev,
    );

    if (apiReady) {
      spaceApi.addMember(Number(spaceId), { userId: Number(userId) }).catch(() => {});
    }
  }, [apiReady, spaces, currentUser.id]);

  const removeMember = useCallback((spaceId: string, userId: string) => {
    const space = spaces.find((s) => s.id === spaceId);
    if (!space || !isSpaceOwner(space, currentUser.id)) return;

    setSpaces((prev) =>
      prev.map((s) =>
        s.id === spaceId
          ? { ...s, members: s.members.filter((m) => m !== userId) }
          : s,
      ),
    );
    setCurrentSpace((prev) =>
      prev.id === spaceId
        ? { ...prev, members: prev.members.filter((m) => m !== userId) }
        : prev,
    );

    if (apiReady) {
      spaceApi.removeMember(Number(spaceId), Number(userId)).catch(() => {});
    }
  }, [apiReady, spaces, currentUser.id]);

  const addGroup = useCallback((spaceId: string, groupId: string) => {
    const space = spaces.find((s) => s.id === spaceId);
    if (!space || !isSpaceOwner(space, currentUser.id)) return Promise.resolve(false);

    if (space.groups.some((group) => group.id === groupId)) return Promise.resolve(true);

    if (apiReady) {
      return spaceApi.addGroup(Number(spaceId), Number(groupId))
        .then(async () => {
          // Reload only this space. Its full DTO contains every linked group and
          // member, so overlapping group membership is re-derived as a union.
          const dto = await spaceApi.getById(Number(spaceId));
          mergeSpaceFromDto(dto);
          return true;
        })
        .catch((e) => {
          alert(e instanceof Error ? e.message : 'Failed to add group');
          return false;
        });
    }

    setSpaces((prev) =>
      prev.map((s) =>
        s.id === spaceId
          ? { ...s, groups: [...s.groups, { id: groupId, name: 'Group', memberIds: [] }] }
          : s,
      ),
    );
    setCurrentSpace((prev) =>
      prev.id === spaceId
        ? { ...prev, groups: [...prev.groups, { id: groupId, name: 'Group', memberIds: [] }] }
        : prev,
    );
    return Promise.resolve(true);
  }, [apiReady, mergeSpaceFromDto, spaces, currentUser.id]);

  const removeGroup = useCallback((spaceId: string, groupId: string) => {
    const space = spaces.find((s) => s.id === spaceId);
    if (!space || !isSpaceOwner(space, currentUser.id)) return Promise.resolve(false);
    if (!space.groups.some((group) => group.id === groupId)) return Promise.resolve(true);

    if (apiReady) {
      return spaceApi.removeGroup(Number(spaceId), Number(groupId))
        .then(async () => {
          // Never call the lean list endpoint here: it has groups: [] and used
          // to make every other group disappear after removing just one.
          const dto = await spaceApi.getById(Number(spaceId));
          mergeSpaceFromDto(dto);
          return true;
        })
        .catch((e) => {
          alert(e instanceof Error ? e.message : 'Failed to remove group');
          return false;
        });
    }

    setSpaces((prev) =>
      prev.map((s) =>
        s.id === spaceId ? { ...s, groups: s.groups.filter((g) => g.id !== groupId) } : s,
      ),
    );
    setCurrentSpace((prev) =>
      prev.id === spaceId ? { ...prev, groups: prev.groups.filter((g) => g.id !== groupId) } : prev,
    );
    return Promise.resolve(true);
  }, [apiReady, mergeSpaceFromDto, spaces, currentUser.id]);

  return (
    <SpaceContext.Provider
      value={{ spaces, currentSpace, setCurrentSpace: setCurrentSpaceAndPersist, hydrateSpace, createSpace, addMember, removeMember, addGroup, removeGroup, refreshSpaces }}
    >
      {children}
    </SpaceContext.Provider>
  );
}

export function useSpaces() {
  const ctx = useContext(SpaceContext);
  if (!ctx) throw new Error('useSpaces must be used inside SpaceProvider');
  return ctx;
}

export interface SpaceGroupInfo {
  id: string;
  name: string;
  memberIds: string[];
}

export interface Space {
  id: string;
  name: string;
  key: string;
  color: string;
  ownerId?: string;
  members: string[];
  groups: SpaceGroupInfo[];
}

/** True when the user created / owns the space (can manage membership). */
export function isSpaceOwner(space: Pick<Space, 'ownerId'>, userId: string): boolean {
  return space.ownerId != null && space.ownerId === userId;
}

/** Direct members plus members inherited from linked groups, de-duplicated. */
export function effectiveSpaceMemberIds(space: Pick<Space, 'members' | 'groups'>): string[] {
  return Array.from(new Set([
    ...space.members.map(String),
    ...space.groups.flatMap((group) => group.memberIds.map(String)),
  ]));
}

export const SPACE_COLORS = [
  '#6366f1',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
];

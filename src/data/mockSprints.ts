import type { Sprint } from '../types/sprint';

export const mockSprints: Sprint[] = [
  {
    id: 'sprint-1',
    name: 'Sprint 1',
    goal: 'Complete core features for MVP launch',
    startDate: 'Feb 24, 2026',
    endDate: 'Mar 7, 2026',
    status: 'active',
  },
  {
    id: 'sprint-2',
    name: 'Sprint 2',
    goal: 'Polish UI and fix critical bugs',
    startDate: 'Mar 9, 2026',
    endDate: 'Mar 21, 2026',
    status: 'future',
  },
];

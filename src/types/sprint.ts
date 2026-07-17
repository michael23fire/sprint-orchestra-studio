export type SprintStatus = 'active' | 'future' | 'completed';

export type SprintReorderAction = 'move_up' | 'move_down' | 'move_to_top' | 'move_to_bottom';

export interface Sprint {
  id: string;
  name: string;
  goal?: string;
  startDate: string;
  endDate: string;
  status: SprintStatus;
  /** Relative order among future sprints (from API). */
  sprintOrder?: number;
}

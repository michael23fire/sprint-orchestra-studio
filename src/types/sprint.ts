export type SprintStatus = 'active' | 'future' | 'completed';

export interface Sprint {
  id: string;
  name: string;
  goal?: string;
  startDate: string;
  endDate: string;
  status: SprintStatus;
}

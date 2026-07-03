import { api } from './client';

export interface IssueHistoryDto {
  id: number;
  issueId: number;
  actorId: number | null;
  actorName: string | null;
  eventType: string;
  fieldName: string | null;
  fromValue: string | null;
  toValue: string | null;
  description: string | null;
  createdAt: string;
}

export const historyApi = {
  getByIssue: (issueId: number) =>
    api.get<IssueHistoryDto[]>(`/api/issues/${issueId}/history`),
};

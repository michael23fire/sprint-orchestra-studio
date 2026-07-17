import { api } from './client';

export interface CommentDto {
  id: number;
  issueId: number;
  authorId: number;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface IssueLinkDto {
  id: number;
  relation: string;
  linkedIssueId: number;
  linkedIssueKey: string;
  linkedIssueTitle: string;
  createdAt: string;
}

export interface IssueAttachmentDto {
  id: number;
  issueId: number;
  uploaderId: number | null;
  uploaderName: string | null;
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number;
  createdAt: string;
  listInAttachmentPanel?: boolean;
}

export interface IssueCodeLinkDto {
  id: number;
  issueId: number;
  issueKey: string;
  url: string;
  kind: 'pull_request' | 'commit' | 'branch' | 'repo' | 'other';
  provider: string;
  owner: string | null;
  repo: string | null;
  refId: string | null;
  title: string | null;
  state: string | null;
  authorLogin: string | null;
  creatorName: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

export interface IssueDto {
  id: number;
  issueKey: string;
  spaceId: number;
  sprintId: number | null;
  sprintName: string | null;
  parentId: number | null;
  parentKey: string | null;
  title: string;
  description: string | null;
  issueType: string;
  status: string;
  priority: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  reporterId: number | null;
  reporterName: string | null;
  storyPoints: number | null;
  startDate: string | null;
  dueDate: string | null;
  issueOrder: number;
  labels: string[];
  /** Supported by newer backends; older ones persist this via the reserved Flagged label. */
  flagged?: boolean;
  comments: CommentDto[];
  childKeys: string[];
  linkedIssues: IssueLinkDto[];
  attachments: IssueAttachmentDto[];
  codeLinks: IssueCodeLinkDto[];
  /** ISO instant — issue row creation time (for lifecycle). */
  createdAt: string | null;
  /** ISO instant — last issue row update. */
  updatedAt: string | null;
}

export interface CreateIssueRequest {
  title: string;
  description?: string;
  issueType?: string;
  status?: string;
  priority?: string;
  assigneeId?: number;
  reporterId?: number;
  sprintId?: number;
  parentId?: number;
  storyPoints?: number;
  startDate?: string;
  dueDate?: string;
  labels?: string[];
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  issueType?: string;
  status?: string;
  priority?: string;
  assigneeId?: number;
  reporterId?: number;
  clearAssignee?: boolean;
  clearReporter?: boolean;
  sprintId?: number;
  clearSprint?: boolean;
  parentId?: number;
  clearParent?: boolean;
  storyPoints?: number;
  startDate?: string;
  dueDate?: string;
  issueOrder?: number;
  labels?: string[];
}

export const issueApi = {
  getBySpace: (spaceId: number) =>
    api.get<IssueDto[]>(`/api/spaces/${spaceId}/issues`),
  getByKey: (spaceId: number, issueKey: string) =>
    api.get<IssueDto>(`/api/spaces/${spaceId}/issues/${issueKey}`),
  create: (spaceId: number, req: CreateIssueRequest) =>
    api.post<IssueDto>(`/api/spaces/${spaceId}/issues`, req),
  update: (spaceId: number, issueKey: string, req: UpdateIssueRequest) =>
    api.put<IssueDto>(`/api/spaces/${spaceId}/issues/${issueKey}`, req),
  delete: (spaceId: number, issueKey: string) =>
    api.delete<void>(`/api/spaces/${spaceId}/issues/${issueKey}`),
};

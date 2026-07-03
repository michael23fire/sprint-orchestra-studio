import { api } from './client';

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

export const attachmentApi = {
  getByIssue: (issueId: number) =>
    api.get<IssueAttachmentDto[]>(`/api/issues/${issueId}/attachments`),
  upload: (issueId: number, file: File, options?: { embedded?: boolean }) => {
    const formData = new FormData();
    formData.append('file', file);
    const q = options?.embedded ? '?embedded=true' : '';
    return api.postForm<IssueAttachmentDto>(`/api/issues/${issueId}/attachments${q}`, formData);
  },
  download: (issueId: number, attachmentId: number) =>
    api.getBlob(`/api/issues/${issueId}/attachments/${attachmentId}/download`),
  delete: (issueId: number, attachmentId: number) =>
    api.delete<void>(`/api/issues/${issueId}/attachments/${attachmentId}`),
};

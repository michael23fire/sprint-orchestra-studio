import type { Ticket } from '../types/ticket';

export const mockTickets: Ticket[] = [
  { id: 'SCRUM-1', title: 'Task 1',          status: 'planned',     assignee: 'Alice', reporter: 'Alice', dueDate: 'Feb 27, 2026', storyPoints: 3,  sprintId: 'sprint-1', labels: ['Feature'] },
  { id: 'SCRUM-2', title: 'Task 2',          status: 'in_progress', assignee: 'John',    reporter: 'Alice', dueDate: 'Mar 4, 2026',  storyPoints: 5,  sprintId: 'sprint-1', labels: ['Frontend'] },
  { id: 'SCRUM-3', title: '設定專案 CI/CD',  status: 'planned',     assignee: 'Charles', reporter: 'Alice', dueDate: 'Feb 28, 2026', storyPoints: 2,  sprintId: 'sprint-1', labels: ['DevOps'] },
  { id: 'SCRUM-4', title: '設計 API 規格',   status: 'in_progress', assignee: 'Alice', reporter: 'John',    dueDate: 'Mar 1, 2026',  storyPoints: 5,  sprintId: 'sprint-1', labels: ['Backend'] },
  { id: 'SCRUM-5', title: '實作登入頁面',    status: 'in_review',   assignee: 'John',    reporter: 'John',    dueDate: 'Mar 5, 2026',  storyPoints: 8,  sprintId: 'sprint-2', labels: ['Frontend', 'Feature'] },
  { id: 'SCRUM-6', title: '首頁版面切版',    status: 'done',        assignee: 'Charles', reporter: 'Alice', dueDate: 'Feb 25, 2026', storyPoints: 3,  sprintId: 'sprint-2', labels: ['Design', 'Frontend'] },
  { id: 'SCRUM-7', title: 'README 文件更新', status: 'done',        assignee: 'Charles', reporter: 'Charles', dueDate: 'Feb 26, 2026', storyPoints: 1,  labels: ['Documentation'] },
  { id: 'SCRUM-8', title: '撰寫單元測試',    status: 'planned',     assignee: 'John',    reporter: 'Alice', storyPoints: 5,  labels: ['Testing'] },
  { id: 'SCRUM-9', title: '效能優化 API',    status: 'planned',     assignee: 'Alice', reporter: 'John',    storyPoints: 8,  labels: ['Performance', 'Backend'] },
];

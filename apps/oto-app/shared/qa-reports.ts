export type QaReportStatus = "draft" | "queued" | "processing" | "complete" | "retrying" | "needs_configuration";
export type QaAssessment = "reported" | "code_supported" | "guidance" | "needs_investigation" | "related_report";

export interface QaContext {
  path: string;
  branchId?: string;
  role?: string;
  browser?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezone?: string;
  appVersion?: string;
}

export interface QaReport {
  id: string;
  title: string;
  status: QaReportStatus;
  assessment: QaAssessment;
  jiraKey: string | null;
  jiraUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  context: QaContext;
}

export interface QaMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface QaAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface QaReportDetail {
  report: QaReport;
  messages: QaMessage[];
  attachments: QaAttachment[];
}

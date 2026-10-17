// Mappers Prisma → DTO for the exam routes (shared by every exam endpoint).

import type {
  ExamDTO,
  ExamDetailDTO,
  ExamKind,
  ExamLinkStatus,
  ExamMessageDTO,
  ExamQuestionDTO,
  ExamQuestionType,
} from "@/lib/types";

type ExamRow = {
  id: string;
  title: string;
  subject: string;
  kind: string;
  fileName: string | null;
  rawText: string;
  linkStatus: string;
  documentIds: string;
  theology: boolean;
  createdAt: Date;
  questions?: {
    id: string;
    idx: number;
    type: string;
    prompt: string;
    options: string | null;
    answer: string | null;
    refs: string;
    rationale: string | null;
  }[];
  messages?: {
    id: string;
    role: string;
    content: string;
    refs: string;
    createdAt: Date;
  }[];
};

type LinkedDoc = { id: string; title: string };

export function toQuestionDTO(row: NonNullable<ExamRow["questions"]>[number]): ExamQuestionDTO {
  return {
    id: row.id,
    idx: row.idx,
    type: (row.type === "qcm" ? "qcm" : "qa") as ExamQuestionType,
    prompt: row.prompt,
    options: row.options ? (JSON.parse(row.options) as string[]) : [],
    answer: row.answer,
    refs: row.refs ? (JSON.parse(row.refs) as string[]) : [],
    rationale: row.rationale,
    answered: Boolean(row.answer && row.answer.trim().length > 0),
  };
}

export function toMessageDTO(row: NonNullable<ExamRow["messages"]>[number]): ExamMessageDTO {
  return {
    id: row.id,
    role: row.role === "user" ? "user" : "agent",
    content: row.content,
    refs: row.refs ? (JSON.parse(row.refs) as string[]) : [],
    createdAt: row.createdAt.toISOString(),
  };
}

export function toExamDTO(
  exam: ExamRow,
  linkedDocs: LinkedDoc[] = []
): ExamDTO {
  const questions = exam.questions ?? [];
  const ids = JSON.parse(exam.documentIds || "[]") as string[];
  return {
    id: exam.id,
    title: exam.title,
    subject: exam.subject,
    kind: (["qcm", "qa", "mixte"].includes(exam.kind) ? exam.kind : "mixte") as ExamKind,
    fileName: exam.fileName,
    linkStatus: (["pending", "linked", "sans"].includes(exam.linkStatus)
      ? exam.linkStatus
      : "pending") as ExamLinkStatus,
    theology: exam.theology,
    questionCount: questions.length,
    answeredCount: questions.filter((q) => q.answer && q.answer.trim().length > 0).length,
    documentIds: ids,
    documentTitles: linkedDocs.filter((d) => ids.includes(d.id)),
    createdAt: exam.createdAt.toISOString(),
  };
}

export function toExamDetailDTO(exam: ExamRow, linkedDocs: LinkedDoc[] = []): ExamDetailDTO {
  return {
    ...toExamDTO(exam, linkedDocs),
    rawText: exam.rawText,
    questions: (exam.questions ?? []).map(toQuestionDTO),
    messages: (exam.messages ?? []).map(toMessageDTO).reverse(),
  };
}

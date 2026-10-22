import type { ApprovalAnswer, ApprovalQuestion } from './types'

export interface QuestionDraft {
  selected: string[]
  text: string
  other: boolean
}

function selectedLabels(entry: QuestionDraft | undefined): string[] {
  if (!entry) return []
  return entry.selected.filter((label) => label.trim().length > 0)
}

function customText(entry: QuestionDraft | undefined): string {
  if (!entry || !entry.other) return ''
  return entry.text.trim()
}

/** 收起自定义回答时连带清空已输入内容，避免“收起后仍被提交”。 */
export function withOtherToggled(entry: QuestionDraft): QuestionDraft {
  const other = !entry.other
  return { ...entry, other, text: other ? entry.text : '' }
}

/** 返回未回答的题目下标：既没有选项，也没有有效的自定义文本。 */
export function validateDrafts(
  questions: readonly ApprovalQuestion[],
  drafts: readonly QuestionDraft[]
): number[] {
  const invalid: number[] = []
  questions.forEach((_question, index) => {
    const entry = drafts[index]
    if (!entry) {
      invalid.push(index)
      return
    }
    if (selectedLabels(entry).length === 0 && !customText(entry)) {
      invalid.push(index)
    }
  })
  return invalid
}

/**
 * 构造答案列表。未回答的题目会被跳过；只有展开“其他”时才会附带文本，
 * 防止收起后残留的 text 被静默提交。
 */
export function buildAnswers(
  questions: readonly ApprovalQuestion[],
  drafts: readonly QuestionDraft[]
): ApprovalAnswer[] {
  const answers: ApprovalAnswer[] = []
  questions.forEach((question, index) => {
    const entry = drafts[index]
    const selected = selectedLabels(entry)
    const text = customText(entry)
    if (selected.length === 0 && !text) return
    answers.push({ question: question.question, selected, text })
  })
  return answers
}

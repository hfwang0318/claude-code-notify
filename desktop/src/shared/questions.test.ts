import { describe, expect, it } from 'vitest'
import type { ApprovalQuestion } from './types'
import {
  buildAnswers,
  nextUnansweredIndex,
  validateDrafts,
  withOtherToggled,
  type QuestionDraft
} from './questions'

function question(overrides: Partial<ApprovalQuestion> = {}): ApprovalQuestion {
  return {
    question: '怎么做？',
    options: [{ label: 'A' }, { label: 'B' }],
    ...overrides
  }
}

function draft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return { selected: [], text: '', other: false, ...overrides }
}

describe('approval question drafts', () => {
  it('收起自定义回答时清空文本，且不再提交该文本', () => {
    const collapsed = withOtherToggled(draft({ selected: ['A'], text: '自己写的', other: true }))
    expect(collapsed.other).toBe(false)
    expect(collapsed.text).toBe('')

    const answers = buildAnswers([question()], [collapsed])
    expect(answers).toEqual([{ question: '怎么做？', selected: ['A'], text: '' }])
  })

  it('即使残留了 text，other 为 false 时也不提交文本也不视为已答', () => {
    const stale = draft({ text: '残留回答', other: false })
    expect(validateDrafts([question()], [stale])).toEqual([0])
    expect(buildAnswers([question()], [stale])).toEqual([])
  })

  it('部分未答时返回所有未答索引', () => {
    const questions = [question(), question({ question: '第二题' }), question({ question: '第三题' })]
    const drafts = [
      draft({ selected: ['A'] }),
      draft(),
      draft({ other: true, text: '   ' })
    ]
    expect(validateDrafts(questions, drafts)).toEqual([1, 2])
  })

  it('多选加自定义文本时同时保留选项和 trim 后的文本', () => {
    const questions = [question({ multiSelect: true })]
    const drafts = [draft({ selected: ['A', 'B'], other: true, text: '  补充说明  ' })]
    expect(validateDrafts(questions, drafts)).toEqual([])
    expect(buildAnswers(questions, drafts)).toEqual([
      { question: '怎么做？', selected: ['A', 'B'], text: '补充说明' }
    ])
  })

  it('全部答完时按题生成答案，缺省草稿视为未答', () => {
    const questions = [question(), question({ question: '第二题', multiSelect: true })]
    const drafts = [draft({ selected: ['B'] }), draft({ selected: ['A'], other: true, text: '还有 C' })]
    expect(validateDrafts(questions, drafts)).toEqual([])
    expect(buildAnswers(questions, drafts)).toEqual([
      { question: '怎么做？', selected: ['B'], text: '' },
      { question: '第二题', selected: ['A'], text: '还有 C' }
    ])
    expect(validateDrafts(questions, [drafts[0]])).toEqual([1])
  })
})

describe('question navigation', () => {
  it('moves to the next unanswered question and wraps to the first', () => {
    const questions = [question({ question: 'Q1' }), question({ question: 'Q2' }), question({ question: 'Q3' })]
    const drafts = [
      draft({ selected: ['A'] }),
      draft(),
      draft({ selected: ['B'] })
    ]
    expect(nextUnansweredIndex(questions, drafts, 0)).toBe(1)
    expect(nextUnansweredIndex(questions, drafts, 1)).toBe(1)
    const allAnswered = [draft({ selected: ['A'] }), draft({ selected: ['A'] }), draft({ selected: ['A'] })]
    expect(nextUnansweredIndex(questions, allAnswered, 0)).toBe(-1)
  })
})

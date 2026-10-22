import type { ApprovalSuggestion } from './types'

const SUGGESTION_DEST_LABELS: Record<string, string> = {
  session: '本次会话',
  localSettings: '本项目',
  projectSettings: '项目共享配置',
  userSettings: '所有项目'
}

const SUGGESTION_MODE_LABELS: Record<string, string> = {
  acceptEdits: '自动接受编辑',
  bypassPermissions: '跳过所有权限询问',
  plan: '切换到计划模式',
  default: '切换回默认模式',
  manual: '切换回默认模式',
  auto: '自动批准低风险操作',
  dontAsk: '不再询问'
}

const SUGGESTION_BEHAVIOR_LABELS: Record<string, string> = {
  allow: '允许',
  deny: '拒绝',
  ask: '询问'
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function describeRuleEntries(raw: unknown, limit = 3): string {
  if (!Array.isArray(raw)) return ''
  const parts: string[] = []
  for (const item of raw.slice(0, limit)) {
    if (!item || typeof item !== 'object') continue
    const rule = item as Record<string, unknown>
    const tool = text(rule.toolName) || text(rule.tool) || text(rule.prompt) || '?'
    const pattern =
      text(rule.ruleContent) || text(rule.rule) || text(rule.prompt)
    parts.push(pattern ? `${tool}(${pattern})` : tool)
  }
  return parts.join('、')
}

export function describeSuggestion(suggestion: ApprovalSuggestion): string {
  const type = text(suggestion.type)
  const destination = text(suggestion.destination)
  const destinationLabel =
    SUGGESTION_DEST_LABELS[destination] || destination || '默认范围'

  if (type === 'setMode') {
    const mode = text(suggestion.mode)
    const modeLabel = SUGGESTION_MODE_LABELS[mode] || mode || '切换模式'
    return `${destinationLabel}内${modeLabel}`
  }

  if (type === 'addRules' || type === 'replaceRules' || type === 'removeRules') {
    const behavior = text(suggestion.behavior) || 'allow'
    const behaviorLabel = SUGGESTION_BEHAVIOR_LABELS[behavior] || behavior
    const detail = describeRuleEntries(suggestion.rules)
    let verb: string
    if (type === 'addRules') {
      verb =
        behavior === 'allow'
          ? '始终允许'
          : behavior === 'deny'
            ? '始终拒绝'
            : behavior === 'ask'
              ? '始终询问'
              : behavior
    } else if (type === 'replaceRules') {
      verb = `将${behaviorLabel}规则替换为`
    } else {
      verb = '移除匹配规则'
    }
    return detail
      ? `${verb} ${detail}（${destinationLabel}）`
      : `${verb}（${destinationLabel}）`
  }

  if (type === 'addDirectories' || type === 'removeDirectories') {
    const directories = Array.isArray(suggestion.directories)
      ? suggestion.directories.map((value) => text(value)).filter(Boolean)
      : []
    let detail = directories.slice(0, 2).join('、')
    if (directories.length > 2) detail += '…'
    const verb = type === 'addDirectories' ? '允许访问目录' : '移除工作目录'
    return detail
      ? `${verb} ${detail}（${destinationLabel}）`
      : `${verb}（${destinationLabel}）`
  }

  if (type) return `始终允许（${destinationLabel}，细则见终端）`
  return '始终允许（细则见终端）'
}

export function unknownSuggestionTypes(
  suggestions: ApprovalSuggestion[]
): string[] {
  const known = new Set([
    'setMode',
    'addRules',
    'replaceRules',
    'removeRules',
    'addDirectories',
    'removeDirectories'
  ])
  return [
    ...new Set(
      suggestions.map((suggestion) => text(suggestion.type) || '<missing>')
    )
  ]
    .filter((type) => !known.has(type))
    .sort()
}

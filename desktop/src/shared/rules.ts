import type { ApprovalItem, ApprovalRule, RuleScope } from './types'
import { approvalCommand } from './session'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function patternMatches(pattern: string, value: string): boolean {
  const trimmed = pattern.trim()
  if (!trimmed || trimmed === '*') return true
  if (trimmed.endsWith(':*')) {
    return value.toLowerCase().startsWith(trimmed.slice(0, -2).toLowerCase())
  }
  if (trimmed.includes('*')) {
    const source = `^${trimmed.split('*').map(escapeRegExp).join('.*')}$`
    try {
      return new RegExp(source, 'i').test(value)
    } catch {
      return false
    }
  }
  return value.trim() === trimmed
}

export function ruleMatches(rule: ApprovalRule, item: ApprovalItem): boolean {
  if (!rule.enabled) return false
  if (rule.scope === 'session' && rule.sessionKey !== item.sessionKey) return false
  if (rule.scope === 'project') {
    if (rule.project !== item.project && rule.project !== item.cwd) return false
  }
  if (rule.origin && rule.origin !== item.origin) return false
  if (rule.tool !== '*' && rule.tool.toLowerCase() !== item.tool.toLowerCase()) return false
  return patternMatches(rule.pattern, approvalCommand(item))
}

export function matchingRule(
  rules: ApprovalRule[],
  item: ApprovalItem
): ApprovalRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, item)) return rule
  }
  return null
}

export function buildRuleFromItem(
  item: ApprovalItem,
  scope: RuleScope,
  id: string,
  now = Date.now()
): ApprovalRule {
  const command = approvalCommand(item)
  return {
    id,
    scope,
    project: scope === 'project' ? item.project : undefined,
    sessionKey: scope === 'session' ? item.sessionKey : undefined,
    tool: item.tool,
    pattern: command.trim() || '*',
    createdAt: now,
    enabled: true
  }
}

export function describeRule(rule: ApprovalRule): string {
  const scope =
    rule.scope === 'global'
      ? '所有项目'
      : rule.scope === 'project'
        ? `项目 ${rule.project || '?'}`
        : '当前会话'
  const origin = rule.origin ? ` · 来源 ${rule.origin}` : ''
  return `${scope}${origin} · ${rule.tool} · ${rule.pattern}`
}

export function validateRule(rule: {
  scope: RuleScope
  tool: string
  pattern: string
}): string {
  if (!rule.tool.trim()) return '请选择工具'
  if (!rule.pattern.trim()) return '请填写匹配内容（全部匹配请显式输入 *）'
  if (rule.pattern.length > 400) return '匹配内容过长'
  return ''
}

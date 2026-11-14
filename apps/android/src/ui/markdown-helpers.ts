import { StyleSheet } from 'react-native'
import { radius, spacing, typeForDensity } from './theme'
import type { ThemeColors, TypographyDensity } from './theme'
import type { Token } from 'markdown-it'

export interface MarkdownNode {
  key: number
  token: Token
  children: MarkdownNode[]
}

export interface TaskItemInfo {
  isTask: boolean
  checked: boolean
  children: MarkdownNode[]
}

function cloneToken(token: Token, patchProps: Partial<Token>): Token {
  return Object.assign(Object.create(Object.getPrototypeOf(token)), token, patchProps)
}

/**
 * Pure, non-mutating task list detector adhering strictly to GFM task list specification.
 * Inspects ONLY the very first text token of the first inline child.
 * Clones nodes/tokens if task prefix is stripped so the original parse tree is 100% immutable.
 */
export function getTaskInfo(node: MarkdownNode): TaskItemInfo {
  if (node.token.type !== 'list_item_open' || node.children.length === 0) {
    return { isTask: false, checked: false, children: node.children }
  }
  const firstChild = node.children[0]
  if (!firstChild) return { isTask: false, checked: false, children: node.children }

  let targetInline: MarkdownNode | null = null
  if (firstChild.token.type === 'paragraph_open' && firstChild.children.length > 0) {
    targetInline = firstChild.children[0] ?? null
  } else if (firstChild.token.type === 'inline') {
    targetInline = firstChild
  }
  if (!targetInline || targetInline.token.type !== 'inline' || !targetInline.token.children?.length) {
    return { isTask: false, checked: false, children: node.children }
  }
  const firstText = targetInline.token.children[0]
  if (!firstText || firstText.type !== 'text') {
    return { isTask: false, checked: false, children: node.children }
  }

  // Must match [ ] or [x]/[X] followed strictly by whitespace or line end
  const m = firstText.content.match(/^\[([ xX])\](\s+|$)/)
  if (!m) {
    return { isTask: false, checked: false, children: node.children }
  }

  // If there is no whitespace within the first text token and there are subsequent tokens,
  // ensure the next token is a line break (softbreak/hardbreak) rather than unspaced inline formatting
  // such as - [x]**suffix** or - [ ]`code`.
  if (m[2] === '' && targetInline.token.children.length > 1) {
    const nextToken = targetInline.token.children[1]
    if (nextToken && nextToken.type !== 'softbreak' && nextToken.type !== 'hardbreak') {
      return { isTask: false, checked: false, children: node.children }
    }
  }

  const checked = (m[1] ?? '').toLowerCase() === 'x'
  const prefixLen = m[0].length

  // Immutably clone without mutating original token content!
  const clonedFirstText = cloneToken(firstText, { content: firstText.content.slice(prefixLen) })
  const clonedInlineToken = cloneToken(targetInline.token, {
    children: [clonedFirstText, ...targetInline.token.children.slice(1)],
  })
  const clonedInlineNode: MarkdownNode = { ...targetInline, token: clonedInlineToken }

  let newChildren: MarkdownNode[]
  if (firstChild.token.type === 'paragraph_open') {
    const clonedP: MarkdownNode = { ...firstChild, children: [clonedInlineNode, ...firstChild.children.slice(1)] }
    newChildren = [clonedP, ...node.children.slice(1)]
  } else {
    newChildren = [clonedInlineNode, ...node.children.slice(1)]
  }

  return { isTask: true, checked, children: newChildren }
}

export function detectAndStripTask(node: MarkdownNode): { isTask: boolean; checked: boolean } {
  const info = getTaskInfo(node)
  return { isTask: info.isTask, checked: info.checked }
}

export interface CalloutInfo {
  isCallout: boolean
  type: 'NOTE' | 'TIP' | 'WARNING' | 'INFO' | 'IMPORTANT' | 'CAUTION'
  title: string
  body: string
}

export interface CalloutNodeInfo {
  isCallout: boolean
  type: CalloutInfo['type']
  title: string
  children: MarkdownNode[]
}

const CALLOUT_TITLES: Record<string, string> = {
  NOTE: '说明',
  TIP: '提示',
  INFO: '信息',
  IMPORTANT: '重要',
  WARNING: '警告',
  CAUTION: '注意',
}

export function parseCallout(text: string): CalloutInfo | null {
  const match = text.match(/^\[!(NOTE|TIP|WARNING|INFO|IMPORTANT|CAUTION)\][^\S\r\n]*(?:([^\r\n]+))?(?:\r?\n([\s\S]*))?$/i)
  if (!match) return null
  const type = (match[1] ?? 'NOTE').toUpperCase() as CalloutInfo['type']
  const customTitle = match[2]?.trim()
  const title = customTitle || CALLOUT_TITLES[type] || type
  const body = match[3]?.trim() ?? ''
  return { isCallout: true, type, title, body }
}

/**
 * Parses blockquote node into a Callout representation while preserving
 * rich markdown children (bold, links, code, lists) and leaving original tokens immutable.
 * Entire declaration line and its trailing line break are cleanly consumed.
 */
export function parseCalloutNode(node: MarkdownNode): CalloutNodeInfo | null {
  if (node.token.type !== 'blockquote_open' || node.children.length === 0) return null
  const firstP = node.children[0]
  if (!firstP || firstP.token.type !== 'paragraph_open' || firstP.children.length === 0) return null
  const inline = firstP.children[0]
  if (!inline || inline.token.type !== 'inline' || !inline.token.children?.length) return null

  // The declaration MUST begin with a plain text token starting with [! (never inline code `[!NOTE]`)
  const firstToken = inline.token.children[0]
  if (!firstToken || firstToken.type !== 'text' || !firstToken.content.startsWith('[!')) {
    return null
  }

  // Declaration line ends at the first softbreak or hardbreak
  const breakIndex = inline.token.children.findIndex((t: Token) => t.type === 'softbreak' || t.type === 'hardbreak')
  const headerTokens = breakIndex >= 0 ? inline.token.children.slice(0, breakIndex) : inline.token.children

  const match = firstToken.content.match(/^\[!(NOTE|TIP|WARNING|INFO|IMPORTANT|CAUTION)\][^\S\r\n]*(.*)$/i)
  if (!match) return null

  const type = (match[1] ?? 'NOTE').toUpperCase() as CalloutInfo['type']
  const firstTokenTitlePart = match[2] || ''
  const remainingHeaderTokensText = headerTokens.slice(1).map((t: Token) => t.content).join('')
  const customTitle = (firstTokenTitlePart + remainingHeaderTokensText).trim()
  const title = customTitle || CALLOUT_TITLES[type] || type

  // Body tokens inside the first paragraph (cleanly stripped of declaration line and its trailing break!)
  const bodyTokens = breakIndex >= 0 ? inline.token.children.slice(breakIndex + 1) : []
  let newChildren: MarkdownNode[]
  if (bodyTokens.length > 0) {
    const clonedInlineToken = cloneToken(inline.token, { children: bodyTokens })
    const clonedInlineNode: MarkdownNode = { ...inline, token: clonedInlineToken }
    const clonedP: MarkdownNode = { ...firstP, children: [clonedInlineNode, ...firstP.children.slice(1)] }
    newChildren = [clonedP, ...node.children.slice(1)]
  } else {
    newChildren = node.children.slice(1)
  }

  return { isCallout: true, type, title, children: newChildren }
}

export function headingStyle(tag: string, styles: ReturnType<typeof createMarkdownStyles>) {
  if (tag === 'h1') return styles.h1
  if (tag === 'h2') return styles.h2
  if (tag === 'h3') return styles.h3
  return styles.h4
}

export function createMarkdownStyles(colors: ThemeColors, density: TypographyDensity = 'compact') {
  const isCompact = density === 'compact'
  const t = typeForDensity(density)
  return StyleSheet.create({
    container: { alignSelf: 'stretch' },
    // Official DeepSeek reading measure: 16px / 28px with generous block spacing.
    paragraph: { fontSize: 16, lineHeight: 28, color: colors.ink, marginBottom: 10, includeFontPadding: false },
    heading: { color: colors.ink, fontWeight: '700', marginTop: 18, marginBottom: 8, includeFontPadding: false },
    h1: { fontSize: 24, lineHeight: 34, includeFontPadding: false },
    h2: { fontSize: 22, lineHeight: 32, includeFontPadding: false },
    h3: { fontSize: 20, lineHeight: 30, includeFontPadding: false },
    h4: { fontSize: 16, lineHeight: 28, fontWeight: '600', includeFontPadding: false },
    strong: { fontWeight: '600' },
    emphasis: { fontStyle: 'italic' },
    strike: { textDecorationLine: 'line-through' },
    link: { color: colors.linkText },
    linkExternal: { color: colors.linkText, fontWeight: '500' },
    linkExternalIcon: { fontSize: 11, color: colors.linkText, fontWeight: '600' },
    citationBadge: { backgroundColor: colors.surfaceStrong, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginHorizontal: 2 },
    citationText: { fontSize: 11, lineHeight: 18, fontWeight: '600', color: colors.linkText },
    blockedLink: { color: colors.muted, textDecorationLine: 'line-through' },
    inlineCode: { fontFamily: 'monospace', fontSize: 14, lineHeight: 22, color: colors.ink, backgroundColor: colors.surfaceStrong, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, includeFontPadding: false },
    mentionCode: { color: colors.linkText, backgroundColor: colors.primarySoft, borderRadius: 4, paddingHorizontal: 4 },
    imageAlt: { color: colors.muted, fontStyle: 'italic' },
    // Official code card: light gray block with a hairline, 13px mono body.
    codeBlock: { alignSelf: 'stretch', borderRadius: 8, backgroundColor: colors.grouped, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, padding: 12, marginBottom: 10 },
    code: { fontFamily: 'monospace', fontSize: 13, lineHeight: 22, color: colors.ink, includeFontPadding: false },
    blockquote: { borderLeftWidth: 3, borderLeftColor: colors.primary, backgroundColor: colors.grouped, paddingLeft: 12, paddingRight: 10, paddingVertical: 6, borderRadius: 6, marginBottom: 10 },
    blockquotePreview: { backgroundColor: colors.grouped, borderColor: 'transparent', borderLeftWidth: 3, borderLeftColor: colors.primary, borderRadius: 6, marginVertical: 4 },
    calloutCard: { borderRadius: radius.md, borderWidth: 1, padding: isCompact ? 10 : 12, marginVertical: isCompact ? 6 : 8, alignSelf: 'stretch' },
    calloutHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
    calloutIconWrap: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
    calloutTitle: { ...t.smallStrong, fontWeight: '600' },
    calloutBody: { fontSize: isCompact ? 15 : 16, lineHeight: isCompact ? 24 : 26, includeFontPadding: false },
    calloutBodyContainer: { marginTop: 4 },
    list: { gap: 4, marginBottom: 10 },
    listItem: { flexDirection: 'row', alignItems: 'flex-start' },
    listMarker: { fontSize: 16, lineHeight: 28, color: colors.ink, width: isCompact ? 22 : 26, includeFontPadding: false },
    listContent: { flex: 1 },
    checkboxChecked: { width: 16, height: 16, borderRadius: 4, alignItems: 'center', justifyContent: 'center' as const, marginRight: isCompact ? 6 : 8, marginTop: 7 },
    checkboxUnchecked: { width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, marginRight: isCompact ? 6 : 8, marginTop: 7 },
    rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginVertical: isCompact ? spacing.sm : spacing.md },
    tableContainer: { alignSelf: 'stretch', marginVertical: isCompact ? 6 : 8 },
    tableScrollContent: { minWidth: '100%' },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden', minWidth: '100%' },
    tableRow: { flexDirection: 'row', minWidth: '100%' },
    tableCell: { flex: 1, minWidth: isCompact ? 80 : 96, paddingHorizontal: isCompact ? 8 : 12, paddingVertical: isCompact ? 6 : 8, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, justifyContent: 'center' },
    tableHeader: { backgroundColor: colors.surfaceStrong },
    tableHeaderText: { fontSize: 15, lineHeight: 25, fontWeight: '500', color: colors.ink, includeFontPadding: false },
    tableText: { fontSize: 15, lineHeight: 25, color: colors.ink, includeFontPadding: false },
  })
}

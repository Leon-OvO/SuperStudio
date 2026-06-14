/**
 * Department metadata (emoji avatar + label + accent color) for AI employees.
 * Single source of truth so the Company roster, chat session badges, and the
 * ChatHeader employee picker all render the same identity for a given dept.
 */
export interface DeptMeta { label: string; color: string; emoji: string }

export const DEPT: Record<string, DeptMeta> = {
  engineering: { label: '工程研发', color: '#7c6cff', emoji: '⚙️' },
  design:      { label: '设计',     color: '#f06bd0', emoji: '🎨' },
  product:     { label: '产品',     color: '#5b9bff', emoji: '📋' },
  marketing:   { label: '营销增长', color: '#f0b429', emoji: '📣' },
  qa:          { label: '测试质量', color: '#3ecf8e', emoji: '🔎' },
  data:        { label: '数据/AI',  color: '#46d3d3', emoji: '🧠' },
  game:        { label: '游戏',     color: '#ff8a5b', emoji: '🎮' },
  finance:     { label: '财务',     color: '#2fb344', emoji: '💰' },
  sales:       { label: '销售',     color: '#ff6b4a', emoji: '🤝' },
  security:    { label: '安全',     color: '#e03131', emoji: '🛡️' },
  legal:       { label: '法务合规', color: '#b08968', emoji: '⚖️' },
  operations:  { label: '运营职能', color: '#b197fc', emoji: '🗂️' },
  research:    { label: '研究',     color: '#15aabf', emoji: '🔬' }
}

export const dept = (k: string): DeptMeta => DEPT[k] || { label: k, color: '#8b91a0', emoji: '🧩' }

import type { ScheduleKind, ScheduleValue } from '../../../../shared/ipc-types'

export interface ScheduledTaskTemplate {
  id: string
  icon: string
  name: string
  prompt: string
  scheduleKind: ScheduleKind
  scheduleValue: ScheduleValue
}

export const TEMPLATES: ScheduledTaskTemplate[] = [
  {
    id: 'daily-briefing',
    icon: '🌅',
    name: '每日早报',
    prompt: '请用搜索工具汇总今天值得关注的科技 / AI 行业新闻 5 条，每条 1 句话总结 + 来源链接，按重要性排序。',
    scheduleKind: 'daily',
    scheduleValue: { time: '09:00' }
  },
  {
    id: 'workday-planner',
    icon: '📋',
    name: '工作日计划',
    prompt: '现在是早上 9 点，请帮我整理今天的工作计划：我可以做的最重要的 3 件事是什么？请考虑优先级、截止时间和精力分配。',
    scheduleKind: 'weekly',
    scheduleValue: { days: [1, 2, 3, 4, 5], time: '09:00' }
  },
  {
    id: 'evening-recap',
    icon: '🌙',
    name: '每晚复盘',
    prompt: '请引导我做一次今日复盘：今天完成了什么？遇到什么阻碍？明天最优先做什么？请用 3 个开放问题逐个提问。',
    scheduleKind: 'daily',
    scheduleValue: { time: '21:00' }
  },
  {
    id: 'monthly-review',
    icon: '📊',
    name: '月度回顾',
    prompt: '请帮我做月度回顾：请用 5 个问题引导我反思本月的目标完成情况、最大的成长、最难的挑战、下月最重要的 1 件事、需要放弃的事。',
    scheduleKind: 'monthly',
    scheduleValue: { day: 1, time: '10:00' }
  }
]

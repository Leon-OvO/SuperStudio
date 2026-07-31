/**
 * 品牌/代号清洗表 —— LLM 产出的技能正文在落盘前按此表替换。
 *
 * 单独成文件是为了让它**可被交付拆分替换掉**：这份清单逐字写出内部代号与厂商名，
 * 本身就属于不能随源码交付的信息（品牌洁净守卫会拦下）。make-split 交付 core 时
 * 把本文件换成空表 stub，真表留在私有 overlay 里。
 *
 * 清洗逻辑本身在 skill-induction.ts 的 brandScrub()，与表分离，不受拆分影响。
 */
export const BRAND_SCRUB: Array<[RegExp, string]> = [
  [/sub2api/gi, '中转'],
  [/xizim/gi, ''],
  [/supercode/gi, ''],
]

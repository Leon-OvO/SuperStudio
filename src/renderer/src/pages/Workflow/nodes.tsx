import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

export type NodeKind =
  | 'text_input'
  | 'variable'
  | 'llm'
  | 'image_generate'
  | 'video_generate'
  | 'web_search'
  | 'file_read'
  | 'file_write'
  | 'gallery_save'
  | 'output'

// Port data types for compatibility validation
export type PortType = 'text' | 'image' | 'video' | 'file' | 'any'

interface PortDef {
  type: PortType
  label: string
}

// Schema for an editable field — drives both defaultData and the NodeInspector UI
export type FieldEditor =
  | { kind: 'text'; placeholder?: string }
  | { kind: 'textarea'; rows?: number; placeholder?: string }
  | { kind: 'number'; min?: number; max?: number; step?: number }
  | { kind: 'select'; options: Array<{ value: string; label: string }> }
  | { kind: 'file'; filters?: Array<{ name: string; extensions: string[] }>; placeholder?: string }
  | { kind: 'provider-model'; role: 'chat' | 'image' | 'video' | 'embedding' }
  | { kind: 'json'; rows?: number }
  | { kind: 'checkbox' }

export interface FieldDef {
  label: string
  help?: string
  default: unknown
  editor: FieldEditor
}

interface NodeDef {
  label: string
  description: string
  color: string
  inputs: PortDef[]
  outputs: PortDef[]
  /** Field schema — keys are saved into node.data, used by inspector + engine. */
  fields: Record<string, FieldDef>
}

const IMAGE_SIZES = [
  { value: '1024x1024', label: '1024×1024 (方形)' },
  { value: '1024x1792', label: '1024×1792 (竖)' },
  { value: '1792x1024', label: '1792×1024 (横)' },
  { value: '512x512', label: '512×512' },
  { value: '768x1344', label: '768×1344 (9:16 竖)' },
  { value: '1344x768', label: '1344×768 (16:9 横)' }
]

const VIDEO_DURATIONS = [
  { value: '5', label: '5 秒' },
  { value: '10', label: '10 秒' },
  { value: '15', label: '15 秒' }
]

const SEARCH_PROVIDERS = [
  { value: '', label: '使用全局设置' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'serper', label: 'Serper' }
]

export const NODE_DEFINITIONS: Record<NodeKind, NodeDef> = {
  text_input: {
    label: '文本输入',
    description: '一段固定文本，作为下游节点的输入起点。',
    color: 'bg-blue-50 border-blue-300',
    inputs: [],
    outputs: [{ type: 'text', label: '文本' }],
    fields: {
      value: {
        label: '文本内容',
        help: '将作为下游节点的文本输入。',
        default: '',
        editor: { kind: 'textarea', rows: 4, placeholder: '在这里输入文本…' }
      }
    }
  },
  variable: {
    label: '变量',
    description: '运行前由用户填写；可在下游节点 prompt 中用 {{变量名}} 引用。',
    color: 'bg-indigo-50 border-indigo-300',
    inputs: [],
    outputs: [{ type: 'text', label: '值' }],
    fields: {
      variableName: {
        label: '变量名',
        help: '运行前的输入框 label，也是 prompt 中 {{...}} 占位符的名称。',
        default: 'input',
        editor: { kind: 'text', placeholder: '例如 topic' }
      },
      defaultValue: {
        label: '默认值',
        help: '运行前如果不修改，将使用此值。',
        default: '',
        editor: { kind: 'text', placeholder: '可留空' }
      }
    }
  },
  llm: {
    label: 'LLM 调用',
    description: '把上游文本作为 user prompt 调用 LLM，可选 system prompt 和自定义模型。',
    color: 'bg-purple-50 border-purple-300',
    inputs: [{ type: 'text', label: '提示词' }],
    outputs: [{ type: 'text', label: '回复' }],
    fields: {
      systemPrompt: {
        label: 'System Prompt',
        help: '可选。定义模型的角色和约束。',
        default: '',
        editor: { kind: 'textarea', rows: 3, placeholder: '例如：你是一名资深编辑…' }
      },
      prompt: {
        label: 'User Prompt 模板',
        help: '上游输入会被插入 {{input}} 位置；其它 {{变量名}} 会被替换为对应变量节点的值。',
        default: '{{input}}',
        editor: { kind: 'textarea', rows: 4, placeholder: '请基于以下内容总结：\n{{input}}' }
      },
      providerModel: {
        label: '模型',
        help: '留空使用「设置 → 默认对话模型」。',
        default: '',
        editor: { kind: 'provider-model', role: 'chat' }
      },
      temperature: {
        label: '温度',
        help: '0 = 稳定，1 = 平衡，>1 = 发散。',
        default: 0.7,
        editor: { kind: 'number', min: 0, max: 2, step: 0.1 }
      }
    }
  },
  image_generate: {
    label: '图片生成',
    description: '用上游文本作为 prompt 生成图片；自动保存到画廊。',
    color: 'bg-pink-50 border-pink-300',
    inputs: [{ type: 'text', label: '提示词' }],
    outputs: [{ type: 'image', label: '图片' }],
    fields: {
      prompt: {
        label: '默认 Prompt',
        help: '当没有上游输入时使用。',
        default: '',
        editor: { kind: 'textarea', rows: 3, placeholder: '描述要生成的图片…' }
      },
      size: {
        label: '尺寸',
        default: '1024x1024',
        editor: { kind: 'select', options: IMAGE_SIZES }
      },
      n: {
        label: '生成数量',
        help: '同时生成几张（DALL-E 系列支持，其它模型可能只生成 1 张）。',
        default: 1,
        editor: { kind: 'number', min: 1, max: 4, step: 1 }
      },
      quality: {
        label: '画质',
        default: 'standard',
        editor: {
          kind: 'select',
          options: [
            { value: 'standard', label: '标准' },
            { value: 'hd', label: '高清' }
          ]
        }
      },
      providerModel: {
        label: '模型',
        help: '留空使用「设置 → 默认图片模型」。',
        default: '',
        editor: { kind: 'provider-model', role: 'image' }
      }
    }
  },
  video_generate: {
    label: '视频生成',
    description: '用上游文本作为 prompt 生成视频；可选参考图。轮询最长 10 分钟。',
    color: 'bg-rose-50 border-rose-300',
    inputs: [{ type: 'text', label: '提示词' }],
    outputs: [{ type: 'video', label: '视频' }],
    fields: {
      prompt: {
        label: '默认 Prompt',
        help: '当没有上游输入时使用。',
        default: '',
        editor: { kind: 'textarea', rows: 3, placeholder: '描述要生成的视频画面…' }
      },
      duration: {
        label: '时长（秒）',
        help: '提交给模型的目标时长。实际支持值取决于具体模型。',
        default: '5',
        editor: { kind: 'select', options: VIDEO_DURATIONS }
      },
      referenceImagePath: {
        label: '参考图（可选）',
        help: '图生视频。如果上游连了 image 节点，会优先使用上游图片。',
        default: '',
        editor: {
          kind: 'file',
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
          placeholder: '点击选择参考图'
        }
      },
      providerModel: {
        label: '模型',
        help: '留空使用「设置 → 默认视频模型」。',
        default: '',
        editor: { kind: 'provider-model', role: 'video' }
      }
    }
  },
  web_search: {
    label: '网络搜索',
    description: '用上游文本作为查询调用 Tavily / Serper，返回摘要文本。',
    color: 'bg-cyan-50 border-cyan-300',
    inputs: [{ type: 'text', label: '查询' }],
    outputs: [{ type: 'text', label: '结果' }],
    fields: {
      query: {
        label: '默认查询',
        help: '当没有上游输入时使用。',
        default: '',
        editor: { kind: 'text', placeholder: '例如：2026 年 AI 行业趋势' }
      },
      maxResults: {
        label: '结果数量',
        default: 5,
        editor: { kind: 'number', min: 1, max: 20, step: 1 }
      },
      provider: {
        label: '搜索提供商',
        help: '留空使用全局设置。',
        default: '',
        editor: { kind: 'select', options: SEARCH_PROVIDERS }
      }
    }
  },
  file_read: {
    label: '读取文件',
    description: '解析本地 XLSX / DOCX / PPTX / PDF 文件，输出结构化文本。',
    color: 'bg-amber-50 border-amber-300',
    inputs: [],
    outputs: [{ type: 'text', label: '内容' }],
    fields: {
      filePath: {
        label: '文件路径',
        help: '支持 .xlsx / .docx / .pptx / .pdf / .txt / .md',
        default: '',
        editor: {
          kind: 'file',
          filters: [{ name: '办公文档', extensions: ['xlsx', 'docx', 'pptx', 'pdf', 'txt', 'md'] }],
          placeholder: '点击选择文件'
        }
      }
    }
  },
  file_write: {
    label: '写入文件',
    description: '按 operations 指令写回 XLSX；自动备份原文件。',
    color: 'bg-orange-50 border-orange-300',
    inputs: [{ type: 'text', label: '操作' }],
    outputs: [{ type: 'text', label: '结果' }],
    fields: {
      filePath: {
        label: '目标文件',
        help: '仅支持 .xlsx；写入前会自动复制到 .backup/ 目录。',
        default: '',
        editor: {
          kind: 'file',
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
          placeholder: '点击选择目标 .xlsx'
        }
      },
      operations: {
        label: 'Operations (JSON 数组)',
        help: '每项 { sheet, action: "set_cell" | "set_range" | "copy_column", params: {…} }。',
        default: [],
        editor: { kind: 'json', rows: 6 }
      }
    }
  },
  gallery_save: {
    label: '保存到画廊',
    description: '把上游的图片/视频写入画廊（含来源标签）。',
    color: 'bg-emerald-50 border-emerald-300',
    inputs: [{ type: 'any', label: '内容' }],
    outputs: [],
    fields: {
      prompt: {
        label: '画廊备注',
        help: '可选。保存到画廊时一并记录的描述。',
        default: '',
        editor: { kind: 'text', placeholder: '简短描述…' }
      }
    }
  },
  output: {
    label: '输出',
    description: '工作流的终点节点。所有连入此节点的内容会被作为最终结果。',
    color: 'bg-slate-50 border-slate-300',
    inputs: [{ type: 'any', label: '内容' }],
    outputs: [],
    fields: {}
  }
}

/** Derive defaultData from the fields schema (used when creating a new node). */
export function buildDefaultData(kind: NodeKind): Record<string, unknown> {
  const def = NODE_DEFINITIONS[kind]
  if (!def) return {}
  const data: Record<string, unknown> = { label: def.label }
  for (const [key, field] of Object.entries(def.fields)) {
    data[key] = field.default
  }
  return data
}

/** Returns true if fromType can connect to toType */
export function isCompatibleConnection(fromType: PortType, toType: PortType): boolean {
  if (fromType === 'any' || toType === 'any') return true
  return fromType === toType
}

/** Get output port type of a node */
export function getNodeOutputType(kind: NodeKind): PortType {
  return NODE_DEFINITIONS[kind]?.outputs[0]?.type ?? 'any'
}

/** Get input port type of a node */
export function getNodeInputType(kind: NodeKind): PortType {
  return NODE_DEFINITIONS[kind]?.inputs[0]?.type ?? 'any'
}

const PORT_TYPE_COLOR: Record<PortType, string> = {
  text: 'bg-blue-400',
  image: 'bg-pink-400',
  video: 'bg-rose-400',
  file: 'bg-amber-400',
  any: 'bg-zinc-400'
}

const PORT_TYPE_LABEL: Record<PortType, string> = {
  text: 'text',
  image: 'img',
  video: 'vid',
  file: 'file',
  any: 'any'
}

function GenericNode({ data, type }: NodeProps) {
  const def = NODE_DEFINITIONS[type as NodeKind]
  if (!def) return null
  const status = (data as Record<string, unknown>)._status as string | undefined
  const label = (data as Record<string, unknown>).label as string
  const inPort = def.inputs[0]
  const outPort = def.outputs[0]

  return (
    <div className={cn(
      'relative px-3 py-2 rounded-lg border-2 min-w-[150px] text-xs shadow-sm',
      def.color,
      status === 'running' && 'ring-2 ring-primary',
      status === 'done' && 'ring-2 ring-green-500',
      status === 'error' && 'ring-2 ring-destructive'
    )}>
      {inPort && (
        <Handle
          type="target"
          position={Position.Left}
          className={cn('!w-2.5 !h-2.5 !border !border-white', PORT_TYPE_COLOR[inPort.type])}
        />
      )}
      <div className="flex items-center gap-1.5">
        {status === 'running' && <Loader2 size={11} className="animate-spin" />}
        {status === 'done' && <CheckCircle size={11} className="text-green-500" />}
        {status === 'error' && <XCircle size={11} className="text-destructive" />}
        <span className="font-medium">{label || def.label}</span>
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{type}</span>
        <div className="flex items-center gap-1">
          {inPort && (
            <span className="text-[9px] px-1 rounded bg-foreground/5 text-foreground/60">
              ← {PORT_TYPE_LABEL[inPort.type]}
            </span>
          )}
          {outPort && (
            <span className="text-[9px] px-1 rounded bg-foreground/5 text-foreground/60">
              {PORT_TYPE_LABEL[outPort.type]} →
            </span>
          )}
        </div>
      </div>
      {outPort && (
        <Handle
          type="source"
          position={Position.Right}
          className={cn('!w-2.5 !h-2.5 !border !border-white', PORT_TYPE_COLOR[outPort.type])}
        />
      )}
    </div>
  )
}

export const NODE_TYPES = {
  text_input: GenericNode,
  variable: GenericNode,
  llm: GenericNode,
  image_generate: GenericNode,
  video_generate: GenericNode,
  web_search: GenericNode,
  file_read: GenericNode,
  file_write: GenericNode,
  gallery_save: GenericNode,
  output: GenericNode
}

// Workflow templates
export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  definition: { nodes: import('@xyflow/react').Node[]; edges: import('@xyflow/react').Edge[] }
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'article-image',
    name: '文章配图流',
    description: '输入主题，LLM 撰写文章，自动生成配图并保存到画廊',
    definition: {
      nodes: [
        { id: 'n1', type: 'text_input', position: { x: 50, y: 150 }, data: { label: '文章主题', value: '' } },
        { id: 'n2', type: 'llm', position: { x: 250, y: 100 }, data: { label: '撰写文章', systemPrompt: '你是一名资深编辑。', prompt: '根据主题写一篇 500 字的文章：\n{{input}}', providerModel: '', temperature: 0.7 } },
        { id: 'n3', type: 'llm', position: { x: 250, y: 220 }, data: { label: '生成图片提示词', systemPrompt: '', prompt: '为以下主题生成一段详细的图片生成提示词（英文）：\n{{input}}', providerModel: '', temperature: 0.7 } },
        { id: 'n4', type: 'image_generate', position: { x: 480, y: 220 }, data: { label: '生成配图', prompt: '', size: '1024x1024', n: 1, quality: 'standard', providerModel: '' } },
        { id: 'n5', type: 'gallery_save', position: { x: 700, y: 220 }, data: { label: '保存到画廊', prompt: '' } },
        { id: 'n6', type: 'output', position: { x: 480, y: 100 }, data: { label: '文章输出' } }
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n3' },
        { id: 'e3', source: 'n2', target: 'n6' },
        { id: 'e4', source: 'n3', target: 'n4' },
        { id: 'e5', source: 'n4', target: 'n5' }
      ]
    }
  },
  {
    id: 'web-research',
    name: '网络调研流',
    description: '搜索主题，LLM 整合搜索结果并输出研究报告',
    definition: {
      nodes: [
        { id: 'n1', type: 'text_input', position: { x: 50, y: 150 }, data: { label: '研究主题', value: '' } },
        { id: 'n2', type: 'web_search', position: { x: 250, y: 150 }, data: { label: '搜索', query: '', maxResults: 5, provider: '' } },
        { id: 'n3', type: 'llm', position: { x: 480, y: 150 }, data: { label: '撰写报告', systemPrompt: '你是一名分析师，擅长把零散的搜索结果整合成结构化报告。', prompt: '根据以下搜索结果，整合并写一份简洁的研究报告：\n{{input}}', providerModel: '', temperature: 0.5 } },
        { id: 'n4', type: 'output', position: { x: 700, y: 150 }, data: { label: '报告输出' } }
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
        { id: 'e3', source: 'n3', target: 'n4' }
      ]
    }
  },
  {
    id: 'video-creation',
    name: '图文短视频流',
    description: '输入主题，生成封面图和视频脚本，生成短视频',
    definition: {
      nodes: [
        { id: 'n1', type: 'text_input', position: { x: 50, y: 150 }, data: { label: '视频主题', value: '' } },
        { id: 'n2', type: 'llm', position: { x: 250, y: 80 }, data: { label: '生成视频提示词', systemPrompt: '', prompt: '为以下主题创作一段 15 秒短视频的画面描述（英文，详细）：\n{{input}}', providerModel: '', temperature: 0.8 } },
        { id: 'n3', type: 'llm', position: { x: 250, y: 220 }, data: { label: '生成封面提示词', systemPrompt: '', prompt: '为以下短视频主题生成一张封面图的描述（英文）：\n{{input}}', providerModel: '', temperature: 0.8 } },
        { id: 'n4', type: 'video_generate', position: { x: 480, y: 80 }, data: { label: '生成视频', prompt: '', duration: '5', referenceImagePath: '', providerModel: '' } },
        { id: 'n5', type: 'image_generate', position: { x: 480, y: 220 }, data: { label: '生成封面', prompt: '', size: '1344x768', n: 1, quality: 'standard', providerModel: '' } },
        { id: 'n6', type: 'gallery_save', position: { x: 700, y: 80 }, data: { label: '保存视频', prompt: '' } },
        { id: 'n7', type: 'gallery_save', position: { x: 700, y: 220 }, data: { label: '保存封面', prompt: '' } }
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n3' },
        { id: 'e3', source: 'n2', target: 'n4' },
        { id: 'e4', source: 'n3', target: 'n5' },
        { id: 'e5', source: 'n4', target: 'n6' },
        { id: 'e6', source: 'n5', target: 'n7' }
      ]
    }
  },
  {
    id: 'data-analysis',
    name: '数据分析流',
    description: '读取 Excel 文件，LLM 分析数据并生成可视化描述',
    definition: {
      nodes: [
        { id: 'n1', type: 'file_read', position: { x: 50, y: 150 }, data: { label: '读取 Excel', filePath: '' } },
        { id: 'n2', type: 'llm', position: { x: 280, y: 150 }, data: { label: '数据分析', systemPrompt: '你是一名数据分析师。', prompt: '分析以下表格数据，提取关键趋势和洞察，以中文输出报告：\n{{input}}', providerModel: '', temperature: 0.3 } },
        { id: 'n3', type: 'llm', position: { x: 280, y: 290 }, data: { label: '生成图表描述', systemPrompt: '', prompt: '根据以下数据，描述一个适合展示的图表类型和内容（用英文，便于生成图片）：\n{{input}}', providerModel: '', temperature: 0.5 } },
        { id: 'n4', type: 'image_generate', position: { x: 520, y: 290 }, data: { label: '生成图表', prompt: '', size: '1344x768', n: 1, quality: 'standard', providerModel: '' } },
        { id: 'n5', type: 'output', position: { x: 520, y: 150 }, data: { label: '分析报告' } },
        { id: 'n6', type: 'gallery_save', position: { x: 760, y: 290 }, data: { label: '保存图表', prompt: '' } }
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n3' },
        { id: 'e3', source: 'n2', target: 'n5' },
        { id: 'e4', source: 'n3', target: 'n4' },
        { id: 'e5', source: 'n4', target: 'n6' }
      ]
    }
  },
  {
    id: 'content-translate',
    name: '多语言内容流',
    description: '输入内容，同时翻译为英文、日文，输出三语版本',
    definition: {
      nodes: [
        { id: 'n1', type: 'text_input', position: { x: 50, y: 200 }, data: { label: '原始内容', value: '' } },
        { id: 'n2', type: 'llm', position: { x: 280, y: 80 }, data: { label: '翻译为英文', systemPrompt: 'You are a professional translator.', prompt: 'Translate the following to English:\n{{input}}', providerModel: '', temperature: 0.3 } },
        { id: 'n3', type: 'llm', position: { x: 280, y: 200 }, data: { label: '翻译为日文', systemPrompt: 'あなたはプロの翻訳者です。', prompt: '次の内容を日本語に翻訳してください：\n{{input}}', providerModel: '', temperature: 0.3 } },
        { id: 'n4', type: 'output', position: { x: 520, y: 80 }, data: { label: '英文版' } },
        { id: 'n5', type: 'output', position: { x: 520, y: 200 }, data: { label: '日文版' } },
        { id: 'n6', type: 'output', position: { x: 280, y: 320 }, data: { label: '中文版（原文）' } }
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n3' },
        { id: 'e3', source: 'n1', target: 'n6' },
        { id: 'e4', source: 'n2', target: 'n4' },
        { id: 'e5', source: 'n3', target: 'n5' }
      ]
    }
  }
]

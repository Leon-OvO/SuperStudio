import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import { getSettings } from './store'

class AbortedError extends Error {
  constructor() { super('file_read: 已被用户中断') }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError()
}

/** Targeted query for spreadsheet reads — lets the agent pull a sheet, a row
 *  range, or just the rows that mention a value, instead of dumping the whole
 *  workbook (a wide config table is easily 100k+ tokens). */
export interface XlsxQuery {
  /** Read just this sheet (by name). Omit to operate over all sheets. */
  sheet?: string
  /** Return only rows where ANY cell contains this substring (case-insensitive),
   *  each prefixed with its row number and shown with the sheet's header row.
   *  The cheapest way to answer "which rows mention X / how is X referenced". */
  search?: string
  /** 1-indexed inclusive row range within `sheet` (header is row 1). */
  startRow?: number
  endRow?: number
  /** Output byte cap (default 11000 — sized to survive the model-facing trim). */
  maxBytes?: number
}

export async function readFile(filePath: string, signal?: AbortSignal, xlsx?: XlsxQuery): Promise<{ content: string; type: string }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `file_read: 文件不存在 "${filePath}". ` +
      `请确认路径正确（应为完整的绝对路径，可在用户消息的"附加文件"清单中找到）。`
    )
  }
  throwIfAborted(signal)
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.xlsx':
    case '.xls':
    case '.ods':            // SheetJS reads OpenDocument spreadsheets too
      return readXlsx(filePath, xlsx)
    case '.docx':
      return readDocx(filePath)
    case '.pptx':
      return readPptx(filePath, signal)
    case '.pdf':
      return readPdf(filePath, signal)
    case '.epub':
      return readEpub(filePath, signal)
    case '.odt':
      return readOpenDocument(filePath, 'odt', signal)
    case '.odp':
      return readOpenDocument(filePath, 'odp', signal)
    case '.rtf':
      return readRtf(filePath)
    case '.doc':
    case '.ppt':
      // Old OLE binary formats — mammoth/adm-zip can't open them (they're not zip).
      throw new Error(
        `暂不支持旧版二进制 ${ext} 格式。请先用 Office / WPS 把它另存为 ` +
        `${ext === '.doc' ? '.docx' : '.pptx'} 后再读取。`
      )
    case '.txt':
    case '.md':
      return { content: fs.readFileSync(filePath, 'utf-8'), type: 'text' }
    default:
      if (IMAGE_EXTS.has(ext)) {
        throw new Error(
          `"${path.basename(filePath)}" 是图片文件（${ext}）。file_read 只用于可提取文字的文档；` +
          `要理解图片内容请改用 vision_analyze 工具。`
        )
      }
      // Extensionless files (SSH private keys id_rsa/id_ed25519, Dockerfile,
      // Makefile, LICENSE…) and allowlisted text/code/data extensions are read
      // as UTF-8 text. Without the `ext === ''` branch, picking a no-extension
      // private key in the SSH importer threw "Unsupported file type: .".
      if (ext === '' || TEXT_EXTS.has(ext)) {
        const raw = fs.readFileSync(filePath, 'utf-8')
        const cap = 1_000_000 // guard context: don't dump a multi-MB file wholesale
        const content = raw.length > cap
          ? raw.slice(0, cap) + `\n\n…[已截断：文件较大，仅显示前 ${cap} 字符]`
          : raw
        return { content, type: 'text' }
      }
      throw new Error(
        `Unsupported file type: ${ext}. 已支持：xlsx/xls/ods、docx、pptx、pdf、epub、odt/odp、rtf，` +
        `以及各类纯文本/代码/数据文件（txt/md/csv/tsv/json/html/xml/yaml/源代码 等）。`
      )
  }
}

// Text-like extensions readFile can return as plain UTF-8 (beyond .txt/.md).
const TEXT_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.json5', '.jsonc', '.xml', '.yaml', '.yml', '.csv', '.tsv', '.log', '.ini', '.conf',
  '.toml', '.env', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bat', '.ps1', '.sql', '.svg', '.vue', '.php', '.rb',
  // extended: more languages / config / markup people routinely hand the agent
  '.tex', '.rst', '.cs', '.kt', '.kts', '.swift', '.scala', '.dart', '.lua',
  '.r', '.pl', '.pm', '.gradle', '.properties', '.scss', '.less',
  '.graphql', '.gql', '.proto', '.cfg', '.srt', '.vtt',
  '.pem', '.key', '.pub', '.crt', '.cer'  // SSH keys / PEM certs (plain text)
])

// Image files: file_read can't extract text from them — steer the agent to
// vision_analyze instead of throwing a generic "unsupported" error.
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ico', '.heic', '.heif', '.avif'
])

const XLSX_MAX_BYTES = 11000 // keep under truncateToolResult's 12000-char model cap

/**
 * Read a spreadsheet for the agent. Without a query: returns the whole workbook
 * if it's small, otherwise a STRUCTURE summary (sheet list + row/col counts) so a
 * 100k-token table can't blow the context — the agent then drills in with a
 * query. With a query: value-search rows, a named sheet, or a row range.
 */
function readXlsx(filePath: string, q?: XlsxQuery): { content: string; type: string } {
  const workbook = XLSX.readFile(filePath)
  const names = workbook.SheetNames
  const maxBytes = Math.min(Math.max(q?.maxBytes ?? XLSX_MAX_BYTES, 1000), 200_000)

  // blankrows:true keeps empty rows as [] so the array index maps 1:1 to the
  // real spreadsheet row — "行N" labels and startRow/endRow then mean the actual
  // row, not a position in a compacted list.
  const rowsOf = (name: string): string[][] =>
    (XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: true, defval: '' }) as unknown[][])
      .map(r => (r || []).map(c => String(c ?? '')))

  const dims = (name: string): { rows: number; cols: number } => {
    const ref = workbook.Sheets[name]?.['!ref']
    if (!ref) return { rows: 0, cols: 0 }
    const r = XLSX.utils.decode_range(ref)
    return { rows: r.e.r - r.s.r + 1, cols: r.e.c - r.s.c + 1 }
  }

  const summary = (): { content: string; type: string } => {
    const list = names.map(n => { const d = dims(n); return `  • ${n}  (${d.rows} 行 × ${d.cols} 列)` }).join('\n')
    return {
      content:
        `【该表较大，已只返回结构，请按需精确读取，避免一次性灌入上下文】\n` +
        `共 ${names.length} 个 sheet：\n${list}\n\n` +
        `下一步用 file_read 的 xlsx 参数精确取（同一个 filePath）：\n` +
        `  · 按值查行（最省、推荐）：sheetSearch="<要找的ID/关键字>"（可加 sheetName 限定）——返回所有命中行+表头\n` +
        `  · 整张表/分段：sheetName="<表名>"（可加 startRow/endRow，1 起算、含表头）`,
      type: 'xlsx',
    }
  }

  // --- value search: which rows mention X (one sheet, or all) ---
  if (q?.search && q.search.trim()) {
    const needle = q.search.trim().toLowerCase()
    const targets = q.sheet ? [q.sheet] : names
    const out: string[] = []
    let bytes = 0, shown = 0, capped = false
    for (const name of targets) {
      if (capped) break
      if (!workbook.Sheets[name]) continue
      const rows = rowsOf(name)
      const header = rows.length ? rows[0].join(',') : ''
      let headerEmitted = false
      for (let i = 0; i < rows.length; i++) {
        const line = rows[i].join(',')
        if (!line.toLowerCase().includes(needle)) continue
        const prefix = headerEmitted ? '' : `## Sheet: ${name}（表头 行1: ${header}）\n`
        const piece = `${prefix}行${i + 1}: ${line}`
        if (bytes + piece.length + 1 > maxBytes) { capped = true; break }
        out.push(piece); bytes += piece.length + 1; shown++; headerEmitted = true
      }
    }
    const scope = q.sheet ? `sheet=${q.sheet}` : `全部 ${names.length} 个 sheet`
    const head = capped
      ? `【在 ${scope} 中搜索 "${q.search}"，已显示 ${shown} 行（结果较多、超出 ${maxBytes} 字节已截断，可能还有更多未显示）】\n\n`
      : `【在 ${scope} 中搜索 "${q.search}"，命中 ${shown} 行】\n\n`
    const tail = capped
      ? `\n\n…[已截断；缩小搜索词或加 sheetName 限定范围以看全]`
      : (shown === 0 ? '（无匹配行。可先不带参数读该文件看 sheet 清单与表头，确认列名/取值格式后再搜）' : '')
    return { content: head + out.join('\n') + tail, type: 'xlsx' }
  }

  // --- single sheet, optionally a row range ---
  if (q?.sheet) {
    if (!workbook.Sheets[q.sheet]) {
      return { content: `指定的 sheet "${q.sheet}" 不存在。可用 sheet：${names.join('、')}`, type: 'xlsx' }
    }
    const rows = rowsOf(q.sheet)
    const total = rows.length
    const start = Math.max((q.startRow ?? 1) - 1, 0)              // 0-based, clamped ≥0
    const end = Math.min(Math.max(q.endRow ?? total, 1), total)  // 1-based inclusive, clamped to 1..total
    if (end <= start) {
      return { content: `参数有误：行范围为空（startRow=${q.startRow ?? 1}, endRow=${q.endRow ?? total}）。startRow 需 ≤ endRow，且都在 1–${total} 内。`, type: 'xlsx' }
    }
    let csv = rows.slice(start, end).map(r => r.join(',')).join('\n')
    let capped = false
    if (csv.length > maxBytes) { csv = csv.slice(0, maxBytes); capped = true }
    const head = `## Sheet: ${q.sheet}  [共 ${total} 行，本次第 ${start + 1}–${end} 行]\n`
    const tail = capped ? `\n…[超出 ${maxBytes} 字节已截断；用 startRow/endRow 取下一段，或用 search 直接定位目标行]` : ''
    return { content: head + csv + tail, type: 'xlsx' }
  }

  // --- no query: whole workbook if small, else a structure summary. Skip
  // serialization entirely when the cell count alone is clearly over budget, so
  // a huge table isn't fully turned into CSV just to measure it. ---
  const totalCells = names.reduce((s, n) => { const d = dims(n); return s + d.rows * d.cols }, 0)
  if (totalCells > maxBytes) return summary()
  const parts: string[] = []
  let acc = 0
  for (const n of names) {
    const part = `## Sheet: ${n}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[n])}`
    acc += part.length + 2
    if (acc > maxBytes) return summary()
    parts.push(part)
  }
  return { content: parts.join('\n\n'), type: 'xlsx' }
}

async function readDocx(filePath: string): Promise<{ content: string; type: string }> {
  const buffer = fs.readFileSync(filePath)
  const result = await mammoth.extractRawText({ buffer })
  return { content: result.value, type: 'docx' }
}

function readPptx(filePath: string, signal?: AbortSignal): { content: string; type: string } {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(filePath)
  const entries = zip.getEntries()
    .filter((e: { entryName: string }) => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a: { entryName: string }, b: { entryName: string }) => a.entryName.localeCompare(b.entryName))

  const parts: string[] = []
  for (let i = 0; i < entries.length; i++) {
    // Decks with hundreds of slides — bail out promptly on cancel
    throwIfAborted(signal)
    const xml = entries[i].getData().toString('utf-8')
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) parts.push(`## Slide ${i + 1}\n${text}`)
  }
  return { content: parts.join('\n\n'), type: 'pptx' }
}

// Decode the handful of XML/HTML entities that survive tag-stripping.
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}
function safeFromCodePoint(n: number): string {
  try { return String.fromCodePoint(n) } catch { return '' }
}

// Strip XML/HTML markup to readable text. Closing block tags become newlines so
// paragraphs / headings / list items / slides don't run together; everything
// else collapses to single spaces.
function stripMarkup(xml: string): string {
  const withBreaks = xml
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|h[1-6]|div|li|tr|text:p|text:h|text:list-item|draw:page|draw:frame)\s*>/gi, '\n')
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ''))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Generic: pull readable text out of a zip-based document (epub / odt / odp).
// `match` selects entry names; entries are processed in numeric-aware name order.
function zipTextEntries(filePath: string, match: (name: string) => boolean, signal?: AbortSignal): string[] {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(filePath)
  const entries = zip.getEntries()
    .filter((e: { entryName: string }) => match(e.entryName))
    .sort((a: { entryName: string }, b: { entryName: string }) =>
      a.entryName.localeCompare(b.entryName, undefined, { numeric: true }))
  const parts: string[] = []
  for (const e of entries) {
    throwIfAborted(signal)
    const text = stripMarkup(e.getData().toString('utf-8'))
    if (text) parts.push(text)
  }
  return parts
}

// EPUB = a zip of XHTML chapters. Extract every (x)html entry in name order —
// good enough for text extraction without parsing the OPF spine for exact order.
function readEpub(filePath: string, signal?: AbortSignal): { content: string; type: string } {
  const parts = zipTextEntries(filePath, n => /\.x?html?$/i.test(n) && !/^meta-inf\//i.test(n), signal)
  return { content: parts.join('\n\n'), type: 'epub' }
}

// OpenDocument text (.odt) / presentation (.odp): all body text lives in
// content.xml. (.ods spreadsheets are handled by SheetJS via readXlsx instead.)
function readOpenDocument(filePath: string, kind: string, signal?: AbortSignal): { content: string; type: string } {
  const parts = zipTextEntries(filePath, n => n === 'content.xml', signal)
  return { content: parts.join('\n\n'), type: kind }
}

// Minimal RTF → plain text. Handles \par/\line/\tab, \uN unicode escapes and
// \'hh hex bytes, drops control words + groups. Lossy for exotic RTF (custom
// codepages, embedded objects) but fine for ordinary rich text documents.
function readRtf(filePath: string): { content: string; type: string } {
  let s = fs.readFileSync(filePath, 'latin1')
  // \uN <fallback> — emit the unicode char, then the RTF spec's ASCII fallback
  // char(s) should be skipped; we just drop the optional trailing '?' / space.
  s = s.replace(/\\u(-?\d+)\s?\??/g, (_, n) => safeFromCodePoint((parseInt(n, 10) + 65536) % 65536))
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
  // Control words may be followed by ONE delimiter space that's part of the token
  // (not content) — consume it so paragraphs don't start with a stray space.
  s = s.replace(/\\pard?\b ?/g, '\n').replace(/\\line\b ?/g, '\n').replace(/\\tab\b ?/g, '\t')
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '')   // remaining control words
  s = s.replace(/[{}]/g, '').replace(/\\[*]?/g, '')
  const content = s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')   // trailing space/tab before a newline
    .replace(/\n[ \t]+/g, '\n')   // leading space/tab after a newline
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { content, type: 'rtf' }
}

async function readPdf(filePath: string, signal?: AbortSignal): Promise<{ content: string; type: string }> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
  // pdfjs needs a worker module to parse. In Electron's Node main process there
  // is no Web Worker, so pdfjs runs a "fake worker" on the main thread by
  // dynamically importing workerSrc — meaning an EMPTY workerSrc throws
  // 'Setting up fake worker failed: "No GlobalWorkerOptions.workerSrc specified."'.
  // Point it at the shipped worker bundle. In a packaged build that file is
  // unpacked out of app.asar (see asarUnpack in package.json), so rewrite the
  // asar path to the real on-disk .unpacked copy before turning it into a file://
  // URL that import() can load. Set once — it's a process-global.
  if (!GlobalWorkerOptions.workerSrc) {
    const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
      .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
  }
  // pdfjs-dist 4.x hard-rejects a Node Buffer (`getDataProp` throws
  // "Please provide binary data as `Uint8Array`, rather than `Buffer`."),
  // and fs.readFileSync returns a Buffer. Copy into a plain Uint8Array so
  // pdfjs accepts it directly (fresh backing buffer ⇒ byteLength matches).
  const data = new Uint8Array(fs.readFileSync(filePath))
  // PDFs are the slowest parse path — check the abort signal between every
  // page so a 500-page PDF doesn't hold the agent loop hostage when the
  // user clicks Stop. pdfjs's loadingTask.destroy() also lets us cancel
  // the in-flight Page reads cleanly.
  const loadingTask = getDocument({ data, useSystemFonts: true })
  let cancelled = false
  const onAbort = () => {
    cancelled = true
    loadingTask.destroy().catch(() => {/* ignore */})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const doc = await loadingTask.promise
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      if (cancelled || signal?.aborted) throw new AbortedError()
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const text = content.items.map(item => ('str' in item ? item.str : '') || '').join(' ')
      pages.push(`## Page ${i}\n${text}`)
    }
    return { content: pages.join('\n\n'), type: 'pdf' }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export interface DirEntry {
  name: string
  type: 'file' | 'dir'
  /** Bytes for files; omitted for directories. */
  size?: number
  /** Absolute path (forward slashes), ready to hand straight to file_read. */
  path: string
}

/** Translate a simple shell glob (only * and ?) into an anchored, case-insensitive
 *  RegExp. Case-insensitive so "*.XLSX" still matches "data.xlsx". */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * List the entries under `dirPath` for the agent's list_dir tool. The CALLER
 * MUST have authorized `dirPath` (isApproved) — this is a pure fs walk with no
 * sandbox check of its own.
 *
 *  - `pattern`: simple name glob (only * and ?) matched against each entry's
 *    basename — applied to BOTH files and directories, so it actually filters the
 *    listing. Recursive DESCENT is independent: subfolders are still walked even
 *    when their name doesn't match, so a deep `*.xlsx` search reaches them.
 *  - `recursive`: walk subfolders, depth-capped (MAX_DEPTH) to avoid pathological
 *    trees; node_modules / .git / dotfolders are not descended into.
 *  - Total entries are capped (MAX_ENTRIES); `truncated` flags when the cap hit,
 *    so a huge directory can't blow the model's context window.
 */
export function listDir(params: { dirPath: string; pattern?: string; recursive?: boolean; limit?: number }): { dir: string; entries: DirEntry[]; truncated: boolean } {
  const { dirPath, pattern, recursive = false } = params
  if (!fs.existsSync(dirPath)) throw new Error(`目录不存在: ${dirPath}`)
  if (!fs.statSync(dirPath).isDirectory()) throw new Error(`不是目录: ${dirPath}`)

  const MAX_ENTRIES = Math.min(Math.max(params.limit ?? 500, 1), 2000)
  const MAX_DEPTH = 4
  const SKIP_DESCEND = new Set(['node_modules', '.git', '.svn', '.hg', '.backup'])
  const matcher = pattern ? globToRegExp(pattern) : null
  const toFwd = (p: string): string => p.replace(/\\/g, '/')

  const entries: DirEntry[] = []
  let truncated = false

  // Resolve the root's real path once so recursive descent can refuse to follow a
  // symlink / Windows junction that escapes it. Without this, a reparse point
  // inside the root would emit child paths that TEXTUALLY start with the root
  // (so the purely-prefix isApproved gate would accept them) while physically
  // pointing elsewhere — a read-escape out of the approved subtree.
  let rootRealNorm: string
  try { rootRealNorm = fs.realpathSync(dirPath).replace(/\\/g, '/').toLowerCase() }
  catch { rootRealNorm = dirPath.replace(/\\/g, '/').toLowerCase() }
  const withinRoot = (p: string): boolean => {
    let real: string
    try { real = fs.realpathSync(p).replace(/\\/g, '/').toLowerCase() } catch { return false }
    return real === rootRealNorm || real.startsWith(rootRealNorm + '/')
  }

  const walk = (dir: string, depth: number): void => {
    if (truncated) return
    let dirents: fs.Dirent[]
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    // Stable order: directories first, then files, each alphabetical.
    dirents.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name))
    for (const d of dirents) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; return }
      const full = path.join(dir, d.name)
      if (d.isDirectory()) {
        // A pattern filters which entries are LISTED (dirs included) — fixes
        // "*技能* and *J* return the same dirs". Descent is independent: still
        // recurse into non-matching dirs so a deep `*.xlsx` search can find them.
        if (!matcher || matcher.test(d.name)) {
          entries.push({ name: d.name, type: 'dir', path: toFwd(full) })
        }
        if (recursive && depth < MAX_DEPTH && !SKIP_DESCEND.has(d.name) && !d.name.startsWith('.') && withinRoot(full)) {
          walk(full, depth + 1)
        }
      } else {
        if (matcher && !matcher.test(d.name)) continue
        let size: number | undefined
        try { size = fs.statSync(full).size } catch { /* unreadable — omit size */ }
        entries.push({ name: d.name, type: 'file', size, path: toFwd(full) })
      }
    }
  }
  walk(dirPath, 0)
  return { dir: toFwd(dirPath), entries, truncated }
}

/**
 * Write arbitrary TEXT to disk (HTML / Markdown / CSV / JSON / code / SVG …).
 * Unlike writeFile (xlsx-only, cell operations), this is the general
 * "save this text as a file" path. Backs up an existing file first (same
 * .backup convention as writeFile) unless appending.
 */
export function writeTextFile(params: { filePath: string; content: string; append?: boolean }): { backupPath?: string; modified: string; created: boolean } {
  const { filePath, content, append } = params
  const targetDir = path.dirname(filePath)
  try { fs.mkdirSync(targetDir, { recursive: true }) } catch { /* may already exist */ }

  const existed = fs.existsSync(filePath)
  let backupPath: string | undefined
  if (existed && !append) {
    const settings = getSettings()
    const backupBase = settings.dataDirectory || path.dirname(filePath)
    const backupDir = path.join(backupBase, '.backup')
    fs.mkdirSync(backupDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const ext = path.extname(filePath)
    backupPath = path.join(backupDir, `${path.basename(filePath, ext)}.${ts}${ext}`)
    fs.copyFileSync(filePath, backupPath)
  }

  if (append && existed) fs.appendFileSync(filePath, content, 'utf-8')
  else fs.writeFileSync(filePath, content, 'utf-8')

  return { backupPath, modified: filePath, created: !existed }
}

interface WriteOperation {
  sheet: string
  action: 'set_cell' | 'set_range' | 'copy_column'
  params: Record<string, unknown>
}

export async function writeFile(params: { filePath: string; operations: WriteOperation[] }): Promise<{ backupPath?: string; modified: string; created?: boolean }> {
  const { filePath, operations } = params

  // Ensure the target directory exists — the agent may target a Desktop path
  // whose tree always exists, but be defensive for nested paths too.
  const targetDir = path.dirname(filePath)
  try { fs.mkdirSync(targetDir, { recursive: true }) } catch { /* may already exist */ }

  // file_write supports BOTH editing an existing xlsx and creating a new one.
  // When the file doesn't exist we synthesize an empty workbook and skip the
  // backup step entirely (nothing to back up).
  const existed = fs.existsSync(filePath)
  let workbook: XLSX.WorkBook
  let backupPath: string | undefined

  if (existed) {
    const settings = getSettings()
    const backupBase = settings.dataDirectory || path.dirname(filePath)
    const backupDir = path.join(backupBase, '.backup')
    fs.mkdirSync(backupDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    backupPath = path.join(backupDir, `${path.basename(filePath, '.xlsx')}.${ts}.xlsx`)
    fs.copyFileSync(filePath, backupPath)
    workbook = XLSX.readFile(filePath)
  } else {
    workbook = XLSX.utils.book_new()
  }

  // Ensure every operation's target sheet exists, lazily creating any missing one
  // with an empty grid. This must run for BOTH a brand-new file AND incremental
  // writes into an EXISTING file: the agent commonly writes keyword-per-sheet
  // across several file_write calls, so a later op targets a sheet (e.g.
  // KW8_…) the already-saved workbook doesn't have yet. Previously only the
  // new-FILE branch pre-created sheets, so writing a new sheet into an existing
  // workbook threw "Sheet not found" and aborted the whole turn mid-task. Fall
  // back to a single 'Sheet1' only for a brand-new file that references no sheet,
  // so XLSX never serializes a zero-sheet workbook.
  const referenced = Array.from(new Set(operations.map(o => o.sheet).filter(Boolean)))
  const ensureSheets = referenced.length ? referenced : (existed ? [] : ['Sheet1'])
  for (const name of ensureSheets) {
    if (!workbook.Sheets[name]) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), name)
    }
  }

  for (const op of operations) {
    const sheet = workbook.Sheets[op.sheet]
    if (!sheet) throw new Error(`Sheet not found: ${op.sheet}`)

    if (op.action === 'set_cell') {
      const { cell, value } = op.params as { cell: string; value: unknown }
      sheet[cell] = { v: value, t: typeof value === 'number' ? 'n' : 's' }
    } else if (op.action === 'copy_column') {
      const { sourceSheet, sourceCol, targetCol, startRow, endRow } =
        op.params as { sourceSheet: string; sourceCol: string; targetCol: string; startRow: number; endRow: number }
      const srcSheet = workbook.Sheets[sourceSheet] || sheet
      const srcData = XLSX.utils.sheet_to_json<unknown[]>(srcSheet, { header: 1 })
      for (let r = startRow - 1; r < Math.min(endRow, srcData.length); r++) {
        const srcRow = srcData[r] as unknown[]
        const colIdx = XLSX.utils.decode_col(sourceCol)
        const tgtCell = `${targetCol}${r + 1}`
        const srcVal = srcRow[colIdx]
        sheet[tgtCell] = { v: srcVal ?? '', t: typeof srcVal === 'number' ? 'n' : 's' }
      }
    } else if (op.action === 'set_range') {
      const { startCell, data } = op.params as { startCell: string; data: unknown[][] }
      const startRef = XLSX.utils.decode_cell(startCell)
      for (let r = 0; r < data.length; r++) {
        const row = data[r]
        for (let c = 0; c < row.length; c++) {
          const cellRef = XLSX.utils.encode_cell({ r: startRef.r + r, c: startRef.c + c })
          const val = row[c]
          sheet[cellRef] = { v: val, t: typeof val === 'number' ? 'n' : 's' }
        }
      }
    }
  }

  // Recompute each sheet's !ref so XLSX serializes every cell we just wrote.
  // Without this, cells added outside the original range can silently drop.
  for (const sheetName of Object.keys(workbook.Sheets)) {
    const sheet = workbook.Sheets[sheetName]
    const cellRefs = Object.keys(sheet).filter(k => !k.startsWith('!'))
    if (cellRefs.length === 0) continue
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity
    for (const ref of cellRefs) {
      const { r, c } = XLSX.utils.decode_cell(ref)
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      if (c < minC) minC = c
      if (c > maxC) maxC = c
    }
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } })
  }

  XLSX.writeFile(workbook, filePath)
  return { backupPath, modified: filePath, created: !existed }
}

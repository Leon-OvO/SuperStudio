import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import { getSettings } from './store'

export async function readFile(filePath: string): Promise<{ content: string; type: string }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `file_read: 文件不存在 "${filePath}". ` +
      `请确认路径正确（应为完整的绝对路径，可在用户消息的"附加文件"清单中找到）。`
    )
  }
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.xlsx':
    case '.xls':
      return readXlsx(filePath)
    case '.docx':
    case '.doc':
      return readDocx(filePath)
    case '.pptx':
    case '.ppt':
      return readPptx(filePath)
    case '.pdf':
      return readPdf(filePath)
    case '.txt':
    case '.md':
      return { content: fs.readFileSync(filePath, 'utf-8'), type: 'text' }
    default:
      throw new Error(`Unsupported file type: ${ext}`)
  }
}

function readXlsx(filePath: string): { content: string; type: string } {
  const workbook = XLSX.readFile(filePath)
  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    parts.push(`## Sheet: ${sheetName}\n${csv}`)
  }
  return { content: parts.join('\n\n'), type: 'xlsx' }
}

async function readDocx(filePath: string): Promise<{ content: string; type: string }> {
  const buffer = fs.readFileSync(filePath)
  const result = await mammoth.extractRawText({ buffer })
  return { content: result.value, type: 'docx' }
}

function readPptx(filePath: string): { content: string; type: string } {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(filePath)
  const entries = zip.getEntries()
    .filter((e: { entryName: string }) => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a: { entryName: string }, b: { entryName: string }) => a.entryName.localeCompare(b.entryName))

  const parts: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const xml = entries[i].getData().toString('utf-8')
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) parts.push(`## Slide ${i + 1}\n${text}`)
  }
  return { content: parts.join('\n\n'), type: 'pptx' }
}

async function readPdf(filePath: string): Promise<{ content: string; type: string }> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
  GlobalWorkerOptions.workerSrc = ''
  const buffer = fs.readFileSync(filePath)
  const doc = await getDocument({ data: buffer, useSystemFonts: true }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map((item: { str?: string }) => item.str || '').join(' ')
    pages.push(`## Page ${i}\n${text}`)
  }
  return { content: pages.join('\n\n'), type: 'pdf' }
}

interface WriteOperation {
  sheet: string
  action: 'set_cell' | 'set_range' | 'copy_column'
  params: Record<string, unknown>
}

export async function writeFile(params: { filePath: string; operations: WriteOperation[] }): Promise<{ backupPath?: string; modified: string }> {
  const { filePath, operations } = params
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `file_write: 文件不存在 "${filePath}". ` +
      `请确认路径正确（应为完整的绝对路径，可在用户消息的"附加文件"清单中找到）。`
    )
  }

  // Auto-backup: store in dataDirectory/.backup, or next to source file if no dataDirectory
  const settings = getSettings()
  const backupBase = settings.dataDirectory || path.dirname(filePath)
  const backupDir = path.join(backupBase, '.backup')
  fs.mkdirSync(backupDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = path.join(backupDir, `${path.basename(filePath, '.xlsx')}.${ts}.xlsx`)
  fs.copyFileSync(filePath, backupPath)

  const workbook = XLSX.readFile(filePath)

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
      const srcData = XLSX.utils.sheet_to_json<Record<string, unknown>>(srcSheet, { header: 1 }) as unknown[][]
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

  XLSX.writeFile(workbook, filePath)
  return { backupPath, modified: filePath }
}

import { createContext, useContext } from 'react'
import type { Node } from '@xyflow/react'
import type { EmployeeInfo } from '../../../../shared/ipc-types'

/**
 * A stable handle onto the canvas's generation/asset operations, exposed by
 * CanvasEditor so the SIBLING panes (left 分镜树, right AI 任务面板, center 「/」
 * composer) can drive the canvas without prop-drilling a dozen callbacks.
 *
 * Everything here is already a useCallback inside CanvasEditor — the bridge just
 * bundles them into one memoised context value (mirrors the existing
 * CanvasContext/CanvasHandlers pattern used by the node components).
 */
export interface CanvasBridge {
  /** Add an image at the canvas center (used by tree click / lightbox「放到画布」). */
  addAtCenter: (path: string) => void
  /** Add an image at a specific flow position (used by tree drag-drop). */
  addImageAt: (path: string, pos: { x: number; y: number }) => void
  /** Fan out N results from selected source node(s), wiring edges back to them. */
  runImageGen: (refPaths: string[], prompt: string, count: number, sourceIds: string[], size: string, quality: string) => void
  /** Like runImageGen but with NO source node — fans results at canvas center
   *  (used by the AI panel + central composer when nothing is selected). */
  runImageGenStandalone: (refPaths: string[], prompt: string, count: number, size: string, quality: string) => void
  /** Pile several reference images into one joint-reference stack at center. */
  createStackAtCenter: () => void
  /** Open the 素材库 picker; target 'card' adds cards, {stackId} appends to a stack. */
  openGalleryPicker: (target: 'card' | { stackId: string }) => void
  /** Open the local-file import dialog (adds picked images as cards). */
  importLocal: () => void
  /** Frame all nodes (top toolbar 全屏 / 适应视图). */
  fitView: () => void
  /** Live canvas state the panes read (selection-driven generation, etc.). */
  nodes: Node[]
  selectedIds: string[]
  /** Selected nodes that are real, done images (valid generation sources). */
  selImageNodes: Node[]
  /** Current canvas doc id (null = unsaved) — keys the per-canvas AI session. */
  currentId: string | null
  /** Hired employees (the「专家团」roster, canvas-level). */
  employees: EmployeeInfo[]
  /** Selected expert ids — 扩写 uses them to enhance the prompt from each专业角度. */
  expertIds: string[]
  setExpertIds: (ids: string[]) => void
}

export const CanvasBridgeContext = createContext<CanvasBridge | null>(null)

export function useCanvasBridge(): CanvasBridge {
  const ctx = useContext(CanvasBridgeContext)
  if (!ctx) throw new Error('useCanvasBridge must be used inside CanvasBridgeContext')
  return ctx
}

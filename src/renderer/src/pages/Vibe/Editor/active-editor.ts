// Singleton handle to the most-recent focused Monaco editor instance.
// The MenuBar's Edit / Selection items call commands on it without having
// to thread a ref through every component layer.

import type * as MonacoNS from 'monaco-editor'

let _active: MonacoNS.editor.IStandaloneCodeEditor | null = null

export function setActiveEditor(e: MonacoNS.editor.IStandaloneCodeEditor | null): void {
  _active = e
}

export function getActiveEditor(): MonacoNS.editor.IStandaloneCodeEditor | null {
  return _active
}

/** Run a built-in Monaco command on the active editor (no-op if none). */
export function runEditorCommand(commandId: string): void {
  const ed = _active
  if (!ed) return
  ed.focus()
  ed.trigger('menubar', commandId, null)
}

/**
 * Configures @monaco-editor/react to use the LOCAL bundled monaco-editor
 * instead of fetching from unpkg CDN (default behavior).
 *
 * Also wires up language workers via Vite's ?worker import suffix.
 * Each language worker handles syntax / IntelliSense for its language.
 *
 * This file MUST be imported once (and only once) before any <Editor> renders.
 */

import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'

// Vite-flavored worker imports — each `?worker` produces a Worker constructor
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Bind workers to MonacoEnvironment so Monaco uses our bundle, not a CDN fetch
;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

// Tell @monaco-editor/react to use our local monaco-editor module
loader.config({ monaco })

// Kick off async init — speeds up first Editor mount
loader.init().catch((e) => {
  // eslint-disable-next-line no-console
  console.warn('[monaco] loader.init failed:', e)
})

export {}

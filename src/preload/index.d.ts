import type { WorkbenchVisionApi } from './index'

declare global {
  interface Window {
    api: WorkbenchVisionApi
  }
}

export {}

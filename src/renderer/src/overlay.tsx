import { createRoot } from 'react-dom/client'
import OverlayApp from './OverlayApp'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root not found')
}

createRoot(container).render(<OverlayApp />)

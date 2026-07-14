import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode disabled: double-invocation of effects causes the first
// WebSocket's onclose to race with the second socket setup and wipe
// wsRef.current, breaking binary sync.
createRoot(document.getElementById('root')!).render(
  <App />
)

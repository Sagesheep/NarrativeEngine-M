import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { wireAllAdapters } from './adapters'
import { useAppStore } from './store/useAppStore'
import { registerStore } from './services/embedding/embeddingScheduler'

// Wire all 6 port adapters BEFORE React mounts.
wireAllAdapters();

// Register the store with the embedding scheduler.
// This is a composition-root concern (main.tsx), not an adapter concern.
registerStore(useAppStore);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { wireNotifications } from './adapters/uiToastAdapter'
import { wireLoreRepository } from './adapters/loreRepositoryAdapter'
import { wireChapterRepository } from './adapters/chapterRepositoryAdapter'
import { wireSettings } from './adapters/settingsAdapter'
import { wireMessaging } from './adapters/messagingAdapter'
import { wireNPC } from './adapters/npcAdapter'

// Wire ports to their real implementations. Services depend on the
// ports (contracts), not the store/components — these calls are what
// actually connect them. Must run before any service/store code that
// uses a port at module load.
wireNotifications();
wireLoreRepository();
wireChapterRepository();
wireSettings();
wireMessaging();
wireNPC();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import './index.css';
import { useAppStore } from './store/useAppStore';
import { CampaignHub } from './components/CampaignHub';
import { Header } from './components/Header';
import { ContextDrawer } from './components/ContextDrawer';
import { ChatArea } from './components/ChatArea';
import { SettingsModal } from './components/SettingsModal';

export default function App() {
  const activeCampaignId = useAppStore((s) => s.activeCampaignId);

  if (!activeCampaignId) {
    return <CampaignHub />;
  }

  return (
    <>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <ContextDrawer />
        <ChatArea />
      </div>
      <SettingsModal />
    </>
  );
}

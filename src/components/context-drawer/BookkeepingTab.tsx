import { useState } from 'react';
import { Briefcase, RefreshCw, User } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { scanInventory } from '../../services/inventoryParser';
import { scanCharacterProfile } from '../../services/characterProfileParser';
import { TemplateField } from './TemplateField';
import { toast } from '../Toast';
import type { LLMProvider } from '../../types';

export function BookkeepingTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const messages = useAppStore((s) => s.messages);
    const getActiveStoryEndpoint = useAppStore((s) => s.getActiveStoryEndpoint);
    const [isScanningInventory, setIsScanningInventory] = useState(false);
    const [isScanningProfile, setIsScanningProfile] = useState(false);

    const handleCheckInventory = async () => {
        if (isScanningInventory) return;
        setIsScanningInventory(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newInventory = await scanInventory(provider as LLMProvider, messages, context.inventory);
            updateContext({ inventory: newInventory });
        } catch (e) {
            console.error('Failed to scan inventory:', e);
            toast.error('Inventory scan failed');
        } finally {
            setIsScanningInventory(false);
        }
    };

    const handlePopulateProfile = async () => {
        if (isScanningProfile) return;
        setIsScanningProfile(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newProfile = await scanCharacterProfile(provider as LLMProvider, messages, context.characterProfile);
            updateContext({ characterProfile: newProfile });
        } catch (e) {
            console.error('Failed to scan character profile:', e);
            toast.error('Character profile scan failed');
        } finally {
            setIsScanningProfile(false);
        }
    };

    return (
        <div className="px-4 py-4 space-y-4">
            <p className="text-[9px] text-text-dim/50">
                Toggle ON = appended to context. Use Check Inventory to auto-update.
            </p>

            <div>
                <TemplateField
                    icon={<Briefcase size={13} />}
                    label="Player Inventory"
                    color="text-ice"
                    value={context.inventory}
                    onChange={(v) => updateContext({ inventory: v })}
                    placeholder={"- 50 Gold Coins\n- Rusty Sword\n- 3x Healing Potions"}
                    rows={6}
                    active={context.inventoryActive}
                    onToggle={() => updateContext({ inventoryActive: !context.inventoryActive })}
                />
                <div className="mt-2 flex justify-end">
                    <button
                        onClick={handleCheckInventory}
                        disabled={isScanningInventory}
                        className="flex items-center gap-2 px-4 md:px-3 py-2.5 md:py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-xs md:text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed group min-h-[48px] md:min-h-0"
                        title="Silent AI generation based on recent chat history"
                    >
                        <RefreshCw size={14} className={`text-terminal md:w-[12px] md:h-[12px] ${isScanningInventory ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                        {isScanningInventory ? 'Scanning...' : 'Check Inventory'}
                    </button>
                </div>
            </div>

            <div className="pt-4 border-t border-border/50">
                <TemplateField
                    icon={<User size={13} />}
                    label="Character Profile"
                    color="text-ember"
                    value={context.characterProfile}
                    onChange={(v) => updateContext({ characterProfile: v })}
                    placeholder={"Name: Eldon\nRace: Elf\nClass: Rogue\nLevel: 3\n\nAbilities:\n- Stealth\n- Backstab"}
                    rows={6}
                    active={context.characterProfileActive}
                    onToggle={() => updateContext({ characterProfileActive: !context.characterProfileActive })}
                />
                <div className="mt-2 flex justify-end">
                    <button
                        onClick={handlePopulateProfile}
                        disabled={isScanningProfile}
                        className="flex items-center gap-2 px-4 md:px-3 py-2.5 md:py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-xs md:text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed group min-h-[48px] md:min-h-0"
                        title="Silent AI generation based on recent chat history"
                    >
                        <RefreshCw size={14} className={`text-terminal md:w-[12px] md:h-[12px] ${isScanningProfile ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                        {isScanningProfile ? 'Scanning...' : 'Populate Profile'}
                    </button>
                </div>
            </div>
        </div>
    );
}

import type { NPCEntry, ChatMessage, LLMProvider } from '../../types';
import { generateNPCProfile, updateExistingNPCs } from './npcGeneration';
import { resolveNpcSelection } from './npcManualResolve';

export type AddNpcResult = {
    ok: boolean;
    kind: 'created' | 'updated' | 'ambiguous' | 'empty' | 'error';
    name?: string;
    message: string;
    matches?: string[];
};

/**
 * Dependency-injected (no store import → testable, no circular dep). The Header
 * assembles these from `useAppStore.getState()`. Reuses the exact same
 * create/update passes as the turn processor — this is the manual trigger.
 */
export type AddNpcDeps = {
    rawText: string;
    ledger: NPCEntry[];
    messages: ChatMessage[];
    campaignId: string;
    storyProvider?: LLMProvider;
    updateProvider?: LLMProvider;
    addNPC: (npc: NPCEntry) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    matureMode?: boolean;   // gates mature-tier traits/wants for the generated NPC (default false)
};

/**
 * Resolve a player's highlighted text against the ledger, then:
 *  - ambiguous (shared family name → 2+ matches): no change, report back.
 *  - update: refresh the single matched NPC from recent context.
 *  - create: generate + populate a new ledger entry.
 */
export async function addNpcFromSelection(deps: AddNpcDeps): Promise<AddNpcResult> {
    const resolution = resolveNpcSelection(deps.rawText, deps.ledger);

    switch (resolution.kind) {
        case 'empty':
            return { ok: false, kind: 'empty', message: 'Couldn’t read a name from the selection.' };

        case 'ambiguous': {
            const matches = resolution.matches.map(m => m.name);
            return {
                ok: false,
                kind: 'ambiguous',
                name: resolution.name,
                matches,
                message: `Multiple "${resolution.name}" in the ledger (${matches.join(', ')}). No change made — highlight a fuller name.`,
            };
        }

        case 'update': {
            if (!deps.updateProvider) return { ok: false, kind: 'error', message: 'No AI provider configured.' };
            try {
                await updateExistingNPCs(deps.updateProvider, deps.messages, [resolution.npc], deps.updateNPC, deps.campaignId);
                return { ok: true, kind: 'updated', name: resolution.npc.name, message: `Updated ${resolution.npc.name}.` };
            } catch (e) {
                return { ok: false, kind: 'error', message: `Update failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        }

        case 'create': {
            if (!deps.storyProvider) return { ok: false, kind: 'error', message: 'No AI provider configured.' };
            try {
                await generateNPCProfile(
                    deps.storyProvider, deps.messages, resolution.name, deps.addNPC,
                    deps.ledger, deps.campaignId,
                    deps.matureMode ?? false,
                );
                return { ok: true, kind: 'created', name: resolution.name, message: `Added ${resolution.name} to the ledger.` };
            } catch (e) {
                return { ok: false, kind: 'error', message: `Add failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        }
    }
}

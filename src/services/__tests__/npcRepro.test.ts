import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from '../npc';
import { dedupeNPCLedger } from '../../store/slices/npcSlice';
import type { NPCEntry, LLMProvider } from '../../types';

// llmCall is the single network boundary inside validateNPCCandidates.
vi.mock('../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../utils/llmCall';
const mockLlmCall = vi.mocked(llmCall);

// Realistic GM output per AI_GM_OS_v3 rule 6: every proper name → [**Name**]
const GM_REPLY = `📅 Dawn | 📍 The Academy Courtyard | 👥 [**Roderick Vaul**], [**Mira**]

[**Roderick Vaul**] strode across the courtyard, his boots crunching on frost.
"You're late," he said, eyes narrowing.

A young apprentice named [**Mira**] hurried after him, clutching a stack of scrolls.
"Apologies, Instructor," [**Mira**] whispered.`;

const PROVIDER = { endpoint: 'http://x', modelName: 'm' } as LLMProvider;

function mk(name: string, aliases = ''): NPCEntry {
    return { id: name.toLowerCase().replace(/\s+/g, '-'), name, aliases } as NPCEntry;
}

beforeEach(() => mockLlmCall.mockReset());

describe('NPC pickup — deterministic chain on real GM format', () => {
    it('extracts both names from the GM reply', () => {
        const names = extractNPCNames(GM_REPLY);
        expect(names).toContain('Roderick Vaul');
        expect(names).toContain('Mira');
    });

    it('classifies them as new and survives dedupe alongside a PC', () => {
        const ledger: NPCEntry[] = [mk('Kael Stormwind')];
        const { newNames } = classifyNPCNames(extractNPCNames(GM_REPLY), ledger);
        let cur = [...ledger];
        for (const n of newNames) cur = dedupeNPCLedger([...cur, mk(n)]);
        expect(cur.map(n => n.name)).toContain('Roderick Vaul');
        expect(cur.map(n => n.name)).toContain('Mira');
    });
});

describe('validateNPCCandidates — root-cause failure modes', () => {
    const candidates = ['Roderick Vaul', 'Mira'];

    it('keeps the LLM-approved subset on a clean array response', async () => {
        mockLlmCall.mockResolvedValue('["Roderick Vaul", "Mira"]');
        expect(await validateNPCCandidates(PROVIDER, candidates, GM_REPLY)).toEqual(candidates);
    });

    it('tolerates reformatted whitespace/case from the model', async () => {
        mockLlmCall.mockResolvedValue('[" roderick vaul ", "MIRA"]');
        expect(await validateNPCCandidates(PROVIDER, candidates, GM_REPLY)).toEqual(candidates);
    });

    // The consistent kill: a weak utility model that can't emit a JSON array.
    it('falls back to unvalidated candidates on a non-array (prose) response', async () => {
        mockLlmCall.mockResolvedValue('Sure! The valid names are Roderick Vaul and Mira.');
        expect(await validateNPCCandidates(PROVIDER, candidates, GM_REPLY)).toEqual(candidates);
    });

    it('falls back on an empty response', async () => {
        mockLlmCall.mockResolvedValue('');
        expect(await validateNPCCandidates(PROVIDER, candidates, GM_REPLY)).toEqual(candidates);
    });

    it('falls back when the response is malformed JSON (parse throws)', async () => {
        mockLlmCall.mockResolvedValue('{ "names": [unclosed and broken');
        expect(await validateNPCCandidates(PROVIDER, candidates, GM_REPLY)).toEqual(candidates);
    });

    it('still honors a genuine rejection (valid empty array)', async () => {
        mockLlmCall.mockResolvedValue('[]');
        expect(await validateNPCCandidates(PROVIDER, candidates, GM_REPLY)).toEqual([]);
    });
});

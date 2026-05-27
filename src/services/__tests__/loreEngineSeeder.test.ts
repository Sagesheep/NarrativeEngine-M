import { describe, it, expect } from 'vitest';
import { extractEngineSeeds } from '../lore';
import type { LoreChunk } from '../../types';

const makeChunk = (category: string, header: string, content: string): LoreChunk => ({
    id: `chunk-${Math.random().toString(36).slice(2)}`,
    header,
    content,
    tokens: content.length,
    alwaysInclude: false,
    triggerKeywords: [],
    scanDepth: 3,
    category: category as LoreChunk['category'],
    linkedEntities: [],
    priority: 5,
});

describe('extractEngineSeeds — character intros', () => {
    it('extracts wandering character with no boost', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Secret Merchant', '**Wandering: true**\n**Appearance:** A cloaked figure\n**Goals:** Profit'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(1);
        expect(seed.characterIntros[0].name).toBe('Secret Merchant');
        expect(seed.characterIntros[0].type).toBe('wandering');
        expect(seed.characterIntros[0].boostKeywords).toBeUndefined();
        expect(seed.characterIntros[0].location).toBeUndefined();
    });

    it('extracts location-bound character', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Cynthia', '**Location: City A**\n**Appearance:** Sharp-eyed woman\n**Goals:** Lend money'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(1);
        expect(seed.characterIntros[0].name).toBe('Cynthia');
        expect(seed.characterIntros[0].type).toBe('location');
        expect(seed.characterIntros[0].location).toBe('City A');
    });

    it('extracts wandering+boosted character', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Bram', '**Wandering: true**\n**Intro Boost:** fighting, brawl, competition\n**Appearance:** Massive scarred man'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(1);
        expect(seed.characterIntros[0].name).toBe('Bram');
        expect(seed.characterIntros[0].type).toBe('wandering+boosted');
        expect(seed.characterIntros[0].boostKeywords).toEqual(['fighting', 'brawl', 'competition']);
    });

    it('extracts location+boosted character', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Guard Captain', '**Location: Castle**\n**Intro Boost:** alarm, attack, siege\n**Appearance:** Armored figure'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(1);
        expect(seed.characterIntros[0].name).toBe('Guard Captain');
        expect(seed.characterIntros[0].type).toBe('location+boosted');
        expect(seed.characterIntros[0].location).toBe('Castle');
        expect(seed.characterIntros[0].boostKeywords).toEqual(['alarm', 'attack', 'siege']);
    });

    it('extracts wandering character that also has a location', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Travelling Healer', '**Wandering: true**\n**Location: Crossroads**\n**Appearance:** A wanderer'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(1);
        expect(seed.characterIntros[0].name).toBe('Travelling Healer');
        expect(seed.characterIntros[0].type).toBe('location');
        expect(seed.characterIntros[0].location).toBe('Crossroads');
    });

    it('skips characters without Wandering or Location tags', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — King Aldric', '**Appearance:** Regal\n**Goals:** Rule the kingdom'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(0);
    });

    it('skips characters with only Intro Boost (no Wandering or Location)', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Invalid', '**Intro Boost:** fight\n**Appearance:** Someone'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(0);
    });

    it('extracts multiple characters from mixed chunks', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Secret Merchant', '**Wandering: true**\n**Appearance:** Cloak'),
            makeChunk('character', 'CHARACTER — Cynthia', '**Location: City A**\n**Appearance:** Ledger'),
            makeChunk('character', 'CHARACTER — King Aldric', '**Appearance:** Regal'),
            makeChunk('faction', 'FACTION — The Guild', '**Goals:** Trade'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros).toHaveLength(2);
        expect(seed.characterIntros.map(c => c.name)).toEqual(['Secret Merchant', 'Cynthia']);
    });

    it('still extracts other engine seeds alongside character intros', () => {
        const chunks: LoreChunk[] = [
            makeChunk('character', 'CHARACTER — Secret Merchant', '**Wandering: true**\n**Goals:** Trade'),
            makeChunk('faction', 'FACTION — The Guild', '**Goals:** Dominate trade\n**Leader:** Guildmaster Zara'),
            makeChunk('location', 'LOCATION — City A', 'A bustling trade hub'),
        ];
        const seed = extractEngineSeeds(chunks);
        expect(seed.characterIntros.length).toBeGreaterThanOrEqual(1);
        expect(seed.worldWho.length).toBeGreaterThanOrEqual(1);
        expect(seed.worldWhere.length).toBeGreaterThanOrEqual(1);
    });
});
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkLoreFile } from '../loreChunker';
import { parseNPCsFromLore } from '../loreNPCParser';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Path from mobileApp/src/services/lore/__tests__ up to the Naruto lore file.
// Walk up: __tests__ -> lore -> services -> src -> mobileApp -> Automated_system -> AI DM Project -> World_compendium
const LORE_PATH = resolve(__dirname, '../../../../../../World_compendium/Naruto/Naruto_AI_optimized.md');

describe('Naruto lore — end-to-end parse of canon NPC blocks', () => {
    it('extracts Naruto, Sasuke, and Sakura with their authored hex + traits', () => {
        const lore = readFileSync(LORE_PATH, 'utf8');
        const chunks = chunkLoreFile(lore);
        const npcs = parseNPCsFromLore(chunks);
        const byName = new Map(npcs.map(n => [n.name.toLowerCase(), n]));

        const naruto = byName.get('naruto uzumaki');
        const sasuke = byName.get('sasuke uchiha');
        const sakura = byName.get('sakura haruno');

        expect(naruto).toBeDefined();
        expect(sasuke).toBeDefined();
        expect(sakura).toBeDefined();
        if (!naruto || !sasuke || !sakura) return;

        // Naruto
        expect(naruto.personalityHex).toEqual({
            drive: 3, diligence: -1, boldness: 3, warmth: 2, empathy: 2, composure: -2,
        });
        expect(naruto.traits).toEqual(['loyal', 'stubborn', 'impulsive', 'competitive', 'protective']);
        expect(naruto.faction).toBe('Konohagakure (Team 7 / Team Kakashi)');

        // Sasuke
        expect(sasuke.personalityHex).toEqual({
            drive: 3, diligence: 2, boldness: 2, warmth: -2, empathy: -1, composure: -1,
        });
        expect(sasuke.traits).toEqual(['vengeful', 'proud', 'obsessive', 'defiant', 'secretive']);

        // Sakura
        expect(sakura.personalityHex).toEqual({
            drive: 2, diligence: 2, boldness: -1, warmth: 1, empathy: 1, composure: 1,
        });
        expect(sakura.traits).toEqual(['competitive', 'protective', 'stubborn', 'loyal', 'curious']);
    });
});
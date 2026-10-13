import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkLoreFile } from '../loreChunker';
import { parseNPCsFromLore } from '../loreNPCParser';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use the repo's own copy of the Naruto lore so the test is self-contained
// (the old path escaped the repo and broke when the app moved directories).
// Walk up: __tests__ -> lore -> services -> src -> repo root.
const LORE_PATH = resolve(__dirname, '../../../../Example_Setup/World_compendium/Naruto/Naruto_AI_optimized.md');

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

    it('preseeds tier=recurring for all three canon NPCs (not oneshot/walkon)', () => {
        const lore = readFileSync(LORE_PATH, 'utf8');
        const npcs = parseNPCsFromLore(chunkLoreFile(lore));
        const byName = new Map(npcs.map(n => [n.name.toLowerCase(), n]));
        expect(byName.get('naruto uzumaki')?.tier).toBe('recurring');
        expect(byName.get('sasuke uchiha')?.tier).toBe('recurring');
        expect(byName.get('sakura haruno')?.tier).toBe('recurring');
    });

    it('extracts region, haunt, boundaries, triggers, wants, and drives', () => {
        const lore = readFileSync(LORE_PATH, 'utf8');
        const npcs = parseNPCsFromLore(chunkLoreFile(lore));
        const byName = new Map(npcs.map(n => [n.name.toLowerCase(), n]));
        const naruto = byName.get('naruto uzumaki');
        const sasuke = byName.get('sasuke uchiha');
        const sakura = byName.get('sakura haruno');
        if (!naruto || !sasuke || !sakura) return;

        // Region — coarse keyword, used by proximity matching (===).
        expect(naruto.region).toBe('konoha');
        expect(sasuke.region).toBe('konoha');
        expect(sakura.region).toBe('konoha');

        // Haunt — flavor-only display string.
        expect(naruto.haunt).toContain('Ichiraku');
        expect(sasuke.haunt).toContain('Uchiha District');
        expect(sakura.haunt).toContain('Konoha Hospital');

        // HardBoundaries — non-empty string list.
        expect(naruto.hardBoundaries?.length).toBeGreaterThan(0);
        expect(naruto.hardBoundaries?.some(b => b.includes('teammate'))).toBe(true);
        expect(sasuke.hardBoundaries?.some(b => b.includes('Itachi'))).toBe(true);

        // SoftBoundaries.
        expect(naruto.softBoundaries?.length).toBeGreaterThan(0);
        expect(sakura.softBoundaries?.some(b => b.includes('protected'))).toBe(true);

        // BehavioralTriggers — {keyword, shift} pairs.
        const narutoItachiTrigger = naruto.behavioralTriggers?.find(t => t.keyword === 'itachi');
        expect(narutoItachiTrigger).toBeDefined();
        expect(narutoItachiTrigger?.shift.length).toBeGreaterThan(0);
        const sasukeMassacreTrigger = sasuke.behavioralTriggers?.find(t => t.keyword === 'massacre mentioned');
        expect(sasukeMassacreTrigger).toBeDefined();

        // Wants — short (list), medium (list), long (string).
        expect(naruto.wants?.short).toContain('train');
        expect(naruto.wants?.short).toContain('eat ramen');
        expect(naruto.wants?.medium?.length).toBeGreaterThan(0);
        expect(naruto.wants?.long).toContain('Hokage');
        expect(sakura.wants?.long).toContain('medic');

        // Drives — coreWant / sessionWant / sceneWant.
        expect(naruto.drives?.coreWant).toContain('acknowledged');
        expect(naruto.drives?.sessionWant).toContain('Sasuke');
        expect(naruto.drives?.sceneWant).toContain('fox');
        expect(sasuke.drives?.coreWant).toContain('massacre');
        expect(sakura.drives?.sessionWant).toContain('equal');
    });
});
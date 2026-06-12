// Build the bundled name bank + detector blocklist from the reviewed asset files.
//
// Plan 05 (NPC name uniqueness) phase 05c. Reads the human-reviewed text assets
// under Upgrade/FablePlans/assets/clean/ and emits two compact JSON files that
// ship inside the app bundle:
//   src/data/nameBank.json      — flat [{ n, c, g }] (name, culture, gender)
//   src/data/nameBlocklist.json — flat [word, ...] from each blocklist's LIVE
//                                  section only (the #ambiguous / #REMOVED / #STATS
//                                  sections are deliberately excluded — they ship
//                                  blocked-NO until a human rules on them).
//
// Run: node scripts/buildNameBank.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLEAN = join(ROOT, 'Upgrade', 'FablePlans', 'assets', 'clean');
const OUT_DIR = join(ROOT, 'src', 'data');

const stripBom = (s) => s.replace(/^﻿/, '');
const VALID_GENDERS = new Set(['m', 'f', 'u']);

function buildNames() {
    const files = readdirSync(CLEAN).filter(
        (f) => f.startsWith('names_') && f.endsWith('.txt') && f !== 'names_REMOVED_log.txt',
    );
    const out = [];
    let dupes = 0;
    for (const file of files) {
        const culture = file.slice('names_'.length, -'.txt'.length); // names_japan.txt -> japan
        const lines = stripBom(readFileSync(join(CLEAN, file), 'utf8')).split(/\r?\n/);
        const seen = new Set();
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;          // header / section markers
            if (/^Name\s*\|\s*g$/i.test(line)) continue;          // the literal column header
            const [namePart, genderPart] = line.split('|');
            const name = (namePart ?? '').trim();
            if (!name) continue;
            let g = (genderPart ?? '').trim().toLowerCase();
            if (!VALID_GENDERS.has(g)) g = 'u';
            const key = name.toLowerCase();
            if (seen.has(key)) { dupes++; continue; }              // within-culture dedupe
            seen.add(key);
            out.push({ n: name, c: culture, g });
        }
        console.log(`  ${culture}: ${seen.size} names`);
    }
    console.log(`names: ${out.length} entries (${dupes} within-culture dupes dropped)`);
    return out;
}

function buildBlocklist() {
    const files = readdirSync(CLEAN).filter((f) => f.startsWith('blocklist_') && f.endsWith('.txt'));
    const seen = new Set();
    for (const file of files) {
        const lines = stripBom(readFileSync(join(CLEAN, file), 'utf8')).split(/\r?\n/);
        let inLive = false;
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith('#blocklist-')) { inLive = true; continue; }
            if (line.startsWith('#')) { inLive = false; continue; } // #ambiguous / #REMOVED / #STATS end the live section
            if (!inLive) continue;
            // a live blocklist line is a single word (ignore any "-- reason" trailers defensively)
            const word = line.split('--')[0].trim().toLowerCase();
            if (word && /^[a-z][a-z'’-]*$/.test(word)) seen.add(word);
        }
    }
    const out = [...seen].sort();
    console.log(`blocklist: ${out.length} live entries (ambiguous excluded)`);
    return out;
}

const names = buildNames();
let blocklist = buildBlocklist();

// Safety rule: names win. Any blocklist word that is also a bank name would make
// that name permanently undetectable as an NPC — a wrong blocklist entry is far
// more dangerous than a missed common noun (design 05b PROMPT E bias). Drop them.
const nameSet = new Set(names.map((e) => e.n.toLowerCase()));
const shadowed = blocklist.filter((w) => nameSet.has(w));
if (shadowed.length > 0) {
    console.log(`dropping ${shadowed.length} blocklist word(s) that shadow bank names: ${shadowed.join(', ')}`);
    blocklist = blocklist.filter((w) => !nameSet.has(w));
}

writeFileSync(join(OUT_DIR, 'nameBank.json'), JSON.stringify(names));
writeFileSync(join(OUT_DIR, 'nameBlocklist.json'), JSON.stringify(blocklist));
console.log(`\nwrote src/data/nameBank.json (${names.length}) + src/data/nameBlocklist.json (${blocklist.length})`);

import type { ArchiveIndexEntry, SemanticFact } from '../types';
import { PROPER_NOUN_STOP_WORDS } from '../utils/stopWords';
import { heuristicImportance } from './importanceRater';

export function extractIndexKeywords(text: string): string[] {
    const keywords = new Set<string>();
    const properNouns = text.match(/[A-Z][A-Za-z]{2,}(?:\s[A-Z][A-Za-z]{2,})*/g) || [];
    for (const noun of properNouns) {
        if (!PROPER_NOUN_STOP_WORDS.has(noun)) keywords.add(noun.toLowerCase());
    }
    const quoted = text.match(/"([^"]{4,60})"/g) || [];
    for (const q of quoted) keywords.add(q.replace(/"/g, '').toLowerCase().trim());
    const memorable = text.match(/\[MEMORABLE:\s*"([^"]+)"\]/g) || [];
    for (const m of memorable) {
        const inner = m.match(/\[MEMORABLE:\s*"([^"]+)"\]/);
        if (inner) keywords.add(inner[1].toLowerCase().trim());
    }
    return Array.from(keywords).slice(0, 20);
}

export function extractNPCNames(text: string): string[] {
    const names = new Set<string>();
    const matches = text.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 '-]{1,30})\*{0,2}\]/g);
    for (const m of matches) names.add(m[1].trim());
    return Array.from(names).slice(0, 15);
}

export function extractKeywordStrengths(text: string, keywords: string[]): Record<string, number> {
    const lower = text.toLowerCase();
    const strengths: Record<string, number> = {};
    const textLen = lower.length;
    for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        let strength = 0;
        let count = 0;
        let pos = 0;
        while ((pos = lower.indexOf(kwLower, pos)) !== -1) {
            count++;
            if (pos < textLen * 0.2) strength += 0.3;
            pos += kwLower.length;
        }
        if (count >= 3) strength += 0.6;
        else if (count >= 2) strength += 0.4;
        else if (count >= 1) strength += 0.2;
        if (lower.includes('[memorable:')) {
            const memIdx = lower.indexOf('[memorable:');
            const memContext = lower.substring(Math.max(0, memIdx - 100), memIdx + 200);
            if (memContext.includes(kwLower)) strength += 0.3;
        }
        strengths[kw] = Math.min(1.0, strength);
    }
    return strengths;
}

export function extractNPCStrengths(text: string, npcNames: string[]): Record<string, number> {
    const lower = text.toLowerCase();
    const strengths: Record<string, number> = {};
    for (const name of npcNames) {
        const nameLower = name.toLowerCase();
        let strength = 0;
        const deathPattern = new RegExp(nameLower + '\\s+(was\\s+)?(killed|slain|died|defeated|destroyed)', 'i');
        const reverseDeath = new RegExp('(killed|slain|defeated|destroyed|murdered)\\s+' + nameLower, 'i');
        if (deathPattern.test(lower) || reverseDeath.test(lower)) {
            strength = 1.0;
        } else {
            let count = 0;
            let pos = 0;
            while ((pos = lower.indexOf(nameLower, pos)) !== -1) { count++; pos += nameLower.length; }
            if (count >= 3) strength = 0.7;
            else if (count >= 2) strength = 0.5;
            else if (count >= 1) strength = 0.3;
            const dialoguePattern = new RegExp(nameLower + '\\s+(said|replied|shouted|whispered|asked|told|exclaimed)', 'i');
            if (dialoguePattern.test(lower)) strength = Math.max(strength, 0.7);
        }
        strengths[name] = Math.min(1.0, strength);
    }
    return strengths;
}

export function extractNPCFacts(npcNames: string[], text: string): SemanticFact[] {
    const facts: SemanticFact[] = [];
    for (const name of npcNames) {
        const killAsSubject = new RegExp(name + '\\s+(killed|slain|defeated|destroyed|murdered)\\s+([A-Z][A-Za-z\\s]{1,30})', 'i');
        const killMatch1 = text.match(killAsSubject);
        if (killMatch1) {
            facts.push({ id: '', subject: name, predicate: killMatch1[1].toLowerCase(), object: killMatch1[2].trim(), importance: 10, sceneId: '', timestamp: 0, source: 'regex' });
        }
        const killAsObject = new RegExp('([A-Z][A-Za-z\\s]{1,30})\\s+(killed|slain|defeated|destroyed|murdered)\\s+' + name, 'i');
        const killMatch2 = text.match(killAsObject);
        if (killMatch2) {
            facts.push({ id: '', subject: name, predicate: 'killed_by', object: killMatch2[1].trim(), importance: 10, sceneId: '', timestamp: 0, source: 'regex' });
        }
        const locPattern = new RegExp(name + '\\s+(entered|arrived at|found in|returned to|fled to)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,40})', 'i');
        const locMatch = text.match(locPattern);
        if (locMatch) {
            facts.push({ id: '', subject: name, predicate: 'located_in', object: locMatch[2].trim(), importance: 5, sceneId: '', timestamp: 0, source: 'regex' });
        }
        // Title extraction (e.g. "Kael, Lord of the Eastern Wastes")
        const titlePattern = new RegExp(name + ',\\s+((?:King|Queen|Lord|Lady|Duke|Prince|Princess|General|Commander|Archmage|Champion)(?:\\s+of\\s+[A-Za-z\\s]+)?)', 'i');
        const titleMatch = text.match(titlePattern);
        if (titleMatch) {
            facts.push({ id: '', subject: name, predicate: 'title', object: titleMatch[1].trim(), importance: 7, sceneId: '', timestamp: 0, source: 'regex' });
        }
        // Faction extraction (e.g. "Kael, leader of the Iron Guard")
        const factionPattern = new RegExp(name + '[\\s,]+(?:leader\\s+of|member\\s+of|of)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,30})', 'i');
        const factionMatch = text.match(factionPattern);
        if (factionMatch) {
            facts.push({ id: '', subject: name, predicate: 'member_of', object: factionMatch[1].trim(), importance: 7, sceneId: '', timestamp: 0, source: 'regex' });
        }
    }
    return facts;
}

export function buildArchiveIndexEntry(
    sceneId: string,
    timestamp: number,
    userContent: string,
    assistantContent: string,
): ArchiveIndexEntry {
    const combinedText = `${userContent}\n${assistantContent}`;
    const keywords = extractIndexKeywords(combinedText);
    const npcNames = extractNPCNames(assistantContent);
    return {
        sceneId,
        timestamp,
        keywords,
        keywordStrengths: extractKeywordStrengths(combinedText, keywords),
        npcsMentioned: npcNames,
        npcStrengths: extractNPCStrengths(assistantContent, npcNames),
        importance: heuristicImportance(combinedText),
        userSnippet: userContent.slice(0, 120),
    };
}

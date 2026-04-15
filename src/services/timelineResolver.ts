import type { TimelineEvent } from '../types';
import { SUPERSEDE_RULES } from '../types';

export type ResolvedTruth = TimelineEvent;

export function resolveTimeline(events: TimelineEvent[]): ResolvedTruth[] {
    if (events.length === 0) return [];

    const groups = new Map<string, TimelineEvent[]>();
    for (const e of events) {
        const key = `${e.subject}|${e.predicate}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(e);
    }

    const resolved: TimelineEvent[] = [];
    for (const groupEvents of groups.values()) {
        groupEvents.sort((a, b) => b.sceneId.localeCompare(a.sceneId));
        resolved.push(groupEvents[0]);
    }

    const subjectPredicates = new Map<string, Set<string>>();
    for (const r of resolved) {
        if (!subjectPredicates.has(r.subject)) subjectPredicates.set(r.subject, new Set());
        subjectPredicates.get(r.subject)!.add(r.predicate);
    }

    const final = resolved.filter(r => {
        for (const [killer, victims] of Object.entries(SUPERSEDE_RULES)) {
            if (subjectPredicates.get(r.subject)?.has(killer) && victims.includes(r.predicate)) {
                return false;
            }
        }
        return true;
    });

    final.sort((a, b) => b.importance - a.importance || a.subject.localeCompare(b.subject));
    return final;
}

export function queryTimeline(
    events: TimelineEvent[],
    filter?: { subject?: string; predicate?: string }
): ResolvedTruth[] {
    const resolved = resolveTimeline(events);
    if (!filter) return resolved;
    return resolved.filter(r => {
        if (filter.subject && !r.subject.toLowerCase().includes(filter.subject.toLowerCase())) return false;
        if (filter.predicate && r.predicate !== filter.predicate) return false;
        return true;
    });
}

export function formatResolvedForContext(resolved: ResolvedTruth[]): string {
    if (resolved.length === 0) return '';
    const lines = resolved.map(r => `${r.subject} → ${r.predicate}: ${r.object} (scene ${r.sceneId})`);
    return `[RESOLVED WORLD STATE]\n${lines.join('\n')}\n[END RESOLVED WORLD STATE]`;
}

export function getEventsByScene(events: TimelineEvent[], sceneId: string): TimelineEvent[] {
    return events.filter(e => e.sceneId === sceneId);
}

export function getEventsByChapter(events: TimelineEvent[], chapterId: string): TimelineEvent[] {
    return events.filter(e => e.chapterId === chapterId);
}

export function getScenesWithEvents(events: TimelineEvent[]): Set<string> {
    return new Set(events.map(e => e.sceneId));
}

export function maxImportanceForScene(events: TimelineEvent[], sceneId: string): number {
    const sceneEvents = getEventsByScene(events, sceneId);
    if (sceneEvents.length === 0) return 0;
    return Math.max(...sceneEvents.map(e => e.importance));
}

import type { TimelineEvent, SemanticFact } from '../../types';
import { uid } from '../../utils/uid';
import { getList, setList, k } from './_helpers';

const TIMELINE_PREDICATES_LIST = [
    'status', 'located_in', 'holds', 'allied_with', 'enemy_of', 'killed_by',
    'controls', 'relationship_to', 'seeks', 'knows_about', 'destroyed', 'misc',
];

export const timelineStorage = {
    async get(cid: string): Promise<TimelineEvent[]> {
        let timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
        if (timeline.length === 0) {
            const facts = await getList<SemanticFact>(k(cid, 'facts'));
            if (facts.length > 0) {
                timeline = facts.map(f => ({
                    id: `tl_${f.id ? f.id.replace('fact_', '') : uid().slice(0, 4)}`,
                    sceneId: f.sceneId || '000',
                    chapterId: 'CH00',
                    subject: f.subject || '',
                    predicate: (TIMELINE_PREDICATES_LIST.includes(f.predicate) ? f.predicate : 'misc') as TimelineEvent['predicate'],
                    object: f.object || '',
                    summary: `${f.subject} ${f.predicate} ${f.object}`,
                    importance: typeof f.importance === 'number' ? f.importance : 5,
                    source: (f.source || 'regex') as TimelineEvent['source'],
                }));
                await setList(k(cid, 'timeline'), timeline);
            }
        }
        return timeline;
    },
    async add(cid: string, event: Partial<TimelineEvent>): Promise<TimelineEvent | null> {
        const { subject, predicate, object: obj } = event;
        if (!subject || !predicate || !obj) return null;
        const timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
        const newEvent: TimelineEvent = {
            id: `tl_${String(timeline.length + 1).padStart(4, '0')}`,
            sceneId: event.sceneId || '000',
            chapterId: event.chapterId || 'CH00',
            subject,
            predicate: (TIMELINE_PREDICATES_LIST.includes(predicate) ? predicate : 'misc') as TimelineEvent['predicate'],
            object: obj,
            summary: event.summary || `${subject} ${predicate} ${obj}`,
            importance: Math.min(10, Math.max(1, typeof event.importance === 'number' ? event.importance : 5)),
            source: 'manual',
        };
        timeline.push(newEvent);
        await setList(k(cid, 'timeline'), timeline);
        return newEvent;
    },
    async remove(cid: string, eventId: string): Promise<boolean> {
        const timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
        const filtered = timeline.filter(e => e.id !== eventId);
        await setList(k(cid, 'timeline'), filtered);
        return timeline.length !== filtered.length;
    },
};

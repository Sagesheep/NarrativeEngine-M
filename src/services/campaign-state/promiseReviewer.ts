import type { ArchiveChapter, DivergenceEntry, DivergenceRegister, LLMProvider, PromiseOutcome } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    extractJsonRobust,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    joinPromptSections,
} from '../infrastructure';
import { isFactActive, isValidStateKey, type PromiseClosure } from './divergenceRegister';
import { compareSceneRef } from './knowledgeScope';

export type PromiseReviewCancelled = { cancelled: boolean };
export type PromiseReviewResult = { closures: PromiseClosure[]; duplicates: Array<{ id: string; of: string }> };

const BATCH_SIZE = 60;
const MAX_CHAPTERS = 120;
const OUTCOMES: ReadonlySet<string> = new Set<PromiseOutcome>(['fulfilled', 'broken', 'void']);

/**
 * "Review promises" — one-time cleanup for registers built before seals could
 * close promises. The utility model reads the open promises against the sealed
 * chapter summaries written after them and reports which were settled and which
 * repeat another. Returns decisions only; applyPromiseReview changes the register,
 * so a cancelled run or failed batch loses nothing.
 */
export async function reviewPromises(
    register: DivergenceRegister,
    chapters: ArchiveChapter[],
    utilityProvider: LLMProvider,
    cancel: PromiseReviewCancelled,
    onStatus: (msg: string) => void,
): Promise<PromiseReviewResult> {
    const open = register.entries
        .filter(e => e.category === 'promises_debts' && isFactActive(e) && !isValidStateKey(e.stateKey))
        .sort((a, b) => compareSceneRef(a.sceneRef, b.sceneRef));
    const sealed = chapters
        .filter(c => c.sealedAt && !c.invalidated && c.summary?.trim())
        .sort((a, b) => compareSceneRef(a.sceneRange[0], b.sceneRange[0]));
    const result: PromiseReviewResult = { closures: [], duplicates: [] };
    if (open.length === 0) return result;

    const batches = Math.ceil(open.length / BATCH_SIZE);
    for (let b = 0; b < batches; b++) {
        if (cancel.cancelled) throw new Error('Review promises cancelled.');
        const batch = open.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        onStatus(`Reviewing promises — batch ${b + 1}/${batches}…`);

        // Only chapters that end after the batch's oldest promise can settle it.
        const relevant = sealed.filter(c => compareSceneRef(c.sceneRange[1], batch[0].sceneRef) >= 0).slice(-MAX_CHAPTERS);
        const labelled = batch.map((fact, i) => ({ label: `P${i + 1}`, fact }));
        const prompt = buildPrompt(labelled, relevant);

        const raw = await llmCall(utilityProvider, prompt, {
            temperature: 0.1,
            maxTokens: 4000,
            timeoutMs: 10 * 60 * 1000,
            trackingLabel: 'promise-reviewer',
        });
        if (cancel.cancelled) throw new Error('Review promises cancelled.');

        const { value } = extractJsonRobust<{ closed?: unknown[]; duplicates?: unknown[] }>(raw, { closed: [], duplicates: [] });
        const parsed = parseReview(value, labelled, relevant);
        result.closures.push(...parsed.closures);
        result.duplicates.push(...parsed.duplicates);
    }
    return result;
}

function buildPrompt(promises: { label: string; fact: DivergenceEntry }[], chapters: ArchiveChapter[]): string {
    const chapterText = chapters.map(c => {
        const events = (c.majorEvents ?? []).slice(0, 8).join('; ');
        return `${c.chapterId} [scenes ${c.sceneRange[0]}-${c.sceneRange[1]}] "${c.title}"\n${c.summary.trim()}${events ? `\nEvents: ${events}` : ''}`;
    }).join('\n\n');

    return joinPromptSections(
        'You are cleaning up the PROMISES & DEBTS list of a TTRPG campaign. Each entry was recorded when the promise was made; nothing ever marked it as kept or broken.',

        `OUTPUT FORMAT — a single JSON object:
{"closed":[{"id":"P3","outcome":"fulfilled","chapter":"CH07"}],"duplicates":[{"id":"P5","of":"P2"}]}`,

        `RULES:
- "closed": promises the CHAPTERS show were settled. outcome: "fulfilled" (kept / paid /
  happened), "broken" (refused, betrayed, failed), "void" (no longer applies — the occasion
  passed, the deal was cancelled, it was overtaken by events). chapter = where it settled;
  it must come after the promise's scene.
- A promise whose own text says it was fulfilled is closed as "fulfilled" in its own chapter.
- A one-off appointment (meet on Friday, coffee after school) the story has clearly moved past
  is "void" if the chapters never show it happening.
- "duplicates": an entry that records the SAME promise as an earlier entry, in other words.
  "of" = the earlier entry. Do not list it in "closed" as well.
- Not settled and not a duplicate = still open: leave it out. If unsure, leave it out.`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `OPEN PROMISES (label [#scene] text):\n${promises.map(p => `${p.label} [#${p.fact.sceneRef}] ${p.fact.text}`).join('\n')}`,
        `CHAPTERS (oldest first):\n${chapterText || '(no sealed chapters)'}`,
    );
}

/** Exported for tests: validates labels, outcomes and chapter order. */
export function parseReview(
    value: { closed?: unknown[]; duplicates?: unknown[] },
    promises: { label: string; fact: DivergenceEntry }[],
    chapters: ArchiveChapter[],
): PromiseReviewResult {
    const byLabel = new Map(promises.map(p => [p.label, p.fact]));
    const chapterById = new Map(chapters.map(c => [c.chapterId, c]));
    const label = (v: unknown) => typeof v === 'string' ? v.trim().toUpperCase() : '';
    const result: PromiseReviewResult = { closures: [], duplicates: [] };
    const used = new Set<string>();

    for (const item of Array.isArray(value.duplicates) ? value.duplicates : []) {
        const r = (item ?? {}) as Record<string, unknown>;
        const dup = byLabel.get(label(r.id));
        const of = byLabel.get(label(r.of));
        if (!dup || !of || dup.id === of.id || used.has(dup.id)) continue;
        used.add(dup.id);
        result.duplicates.push({ id: dup.id, of: of.id });
    }
    for (const item of Array.isArray(value.closed) ? value.closed : []) {
        const r = (item ?? {}) as Record<string, unknown>;
        const fact = byLabel.get(label(r.id));
        const outcome = typeof r.outcome === 'string' ? r.outcome.trim().toLowerCase() : '';
        if (!fact || used.has(fact.id) || !OUTCOMES.has(outcome)) continue;
        const ch = typeof r.chapter === 'string' ? chapterById.get(r.chapter.trim().toUpperCase()) : undefined;
        // A chapter that ended before the promise was made cannot have settled it.
        if (ch && compareSceneRef(ch.sceneRange[1], fact.sceneRef) < 0) continue;
        used.add(fact.id);
        result.closures.push({ factId: fact.id, outcome: outcome as PromiseOutcome, ...(ch ? { sceneRef: ch.sceneRange[1] } : {}) });
    }
    return result;
}

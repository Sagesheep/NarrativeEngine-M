/**
 * PC Creation sub-components — extracted from PCCreationWizard.tsx (W11).
 * QuestionsStep, QuestionField, StatsStep, ReviewStep.
 */

import { STAT_KEYS, getPointCost, PC_POINT_BUY, getPCTier, ARCHETYPE_PRESETS, CREATION_QUESTIONS, type StatKey, type CreationQuestion } from '../../services/engine/pcCreationScript';
import type { StatBlock, Archetype } from '../../types';

type QuestionAnswers = Record<string, string>;

export function QuestionsStep({ answers, onAnswer, onSuggest, suggestingField, auxAvailable, onOpenPrimer, onAdvance, canAdvance }: {
    answers: QuestionAnswers;
    onAnswer: (field: string, value: string) => void;
    onSuggest: (questionId: string) => void;
    suggestingField: string | null;
    auxAvailable: boolean;
    onOpenPrimer: () => void;
    onAdvance: () => void;
    canAdvance: boolean;
}) {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-widest text-text-dim">Tell us about your character</p>
                {auxAvailable && (
                    <button onClick={onOpenPrimer} className="text-[10px] text-terminal/60 hover:text-terminal transition-colors">
                        Browse World Lore
                    </button>
                )}
            </div>
            {CREATION_QUESTIONS.map(q => (
                <QuestionField
                    key={q.id}
                    question={q}
                    value={answers[q.id] || ''}
                    onChange={(v) => onAnswer(q.id, v)}
                    onSuggest={() => onSuggest(q.id)}
                    suggesting={suggestingField === q.id}
                    auxAvailable={auxAvailable}
                />
            ))}
            <button
                onClick={onAdvance}
                disabled={!canAdvance}
                className={`w-full py-2 rounded text-[11px] uppercase tracking-widest transition-colors ${canAdvance ? 'bg-terminal/20 text-terminal hover:bg-terminal/30' : 'bg-void-dark/50 text-void-dark/30 cursor-not-allowed'}`}
            >
                Continue to Stats
            </button>
        </div>
    );
}

export function QuestionField({ question, value, onChange, onSuggest, suggesting, auxAvailable }: {
    question: CreationQuestion;
    value: string;
    onChange: (v: string) => void;
    onSuggest: () => void;
    suggesting: boolean;
    auxAvailable: boolean;
}) {
    const isNarrative = ['concept', 'voice', 'drives'].includes(question.id);
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-widest text-text-dim">
                    {question.prompt} {question.required && <span className="text-red-400">*</span>}
                </label>
                {auxAvailable && isNarrative && (
                    <button
                        onClick={onSuggest}
                        disabled={suggesting}
                        className="text-[10px] text-terminal/60 hover:text-terminal transition-colors"
                    >
                        {suggesting ? 'Suggesting...' : 'Suggest from world'}
                    </button>
                )}
            </div>
            {question.type === 'select' ? (
                <select
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className="w-full bg-void-dark border border-border rounded px-2 py-1.5 text-[13px] text-text-bright focus:border-terminal outline-none"
                >
                    <option value="">-- Select --</option>
                    {question.options?.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </select>
            ) : question.type === 'textarea' ? (
                <textarea
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    rows={2}
                    className="w-full bg-void-dark border border-border rounded px-2 py-1.5 text-[13px] text-text-bright focus:border-terminal outline-none resize-none"
                    placeholder={question.required ? 'Required' : 'Optional'}
                />
            ) : (
                <input
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className="w-full bg-void-dark border border-border rounded px-2 py-1.5 text-[13px] text-text-bright focus:border-terminal outline-none"
                    placeholder={question.required ? 'Required' : 'Optional'}
                />
            )}
        </div>
    );
}

export function StatsStep({ stats, budget, allocation, isOP, selectedArchetype, onStatChange, onArchetypePreset, onOPToggle, onAdvance }: {
    stats: StatBlock;
    budget: 'NORMAL' | 'OP';
    allocation: { pointsSpent: number; pointsRemaining: number; isValid: boolean };
    isOP: boolean;
    selectedArchetype: Archetype | null;
    onStatChange: (key: StatKey, delta: number) => void;
    onArchetypePreset: (archetype: Archetype) => void;
    onOPToggle: () => void;
    onAdvance: () => void;
}) {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-widest text-text-dim">
                    Allocate your stats — {budget} budget ({allocation.pointsRemaining} points remaining)
                </p>
            </div>

            {/* OP toggle */}
            <div className="flex items-center gap-3">
                <button
                    onClick={onOPToggle}
                    className={`px-3 py-1 rounded text-[11px] uppercase tracking-widest transition-colors ${isOP ? 'bg-terminal/30 text-terminal' : 'bg-void-dark/50 text-text-dim hover:text-text-bright'}`}
                >
                    {isOP ? 'OP Mode (Elite tier)' : 'Normal Mode (Grunt tier)'}
                </button>
                <span className="text-[9px] text-text-dim">
                    {isOP ? '37 points, stats up to 20' : '27 points, stats 8-15'}
                </span>
            </div>

            {/* Archetype presets */}
            <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-text-dim">Quick presets</p>
                <div className="flex flex-wrap gap-2">
                    {(Object.entries(ARCHETYPE_PRESETS) as [Archetype, StatBlock][]).map(([arch, _preset]) => (
                        <button
                            key={arch}
                            onClick={() => onArchetypePreset(arch)}
                            className={`px-2 py-1 rounded text-[10px] uppercase tracking-wider transition-colors ${selectedArchetype === arch ? 'bg-terminal/20 text-terminal border border-terminal/40' : 'bg-void-dark/50 text-text-dim hover:text-text-bright border border-border'}`}
                        >
                            {arch}
                        </button>
                    ))}
                </div>
            </div>

            {/* Point-buy sliders */}
            <div className="space-y-2">
                {STAT_KEYS.map(key => {
                    const cost = getPointCost(stats[key], budget);
                    return (
                        <div key={key} className="flex items-center gap-2">
                            <span className="w-10 text-[10px] uppercase tracking-widest text-text-dim">{key}</span>
                            <button onClick={() => onStatChange(key, -1)} className="w-6 h-6 flex items-center justify-center bg-void-dark border border-border rounded text-[13px] text-text-dim hover:text-terminal transition-colors">-</button>
                            <span className={`w-8 text-center text-[13px] ${allocation.isValid ? 'text-text-bright' : 'text-red-400'}`}>{stats[key]}</span>
                            <button onClick={() => onStatChange(key, 1)} className="w-6 h-6 flex items-center justify-center bg-void-dark border border-border rounded text-[13px] text-text-dim hover:text-terminal transition-colors">+</button>
                            <span className="text-[9px] text-text-dim">cost: {cost}</span>
                        </div>
                    );
                })}
            </div>

            {!allocation.isValid && (
                <p className="text-red-400 text-[10px]">Invalid allocation: you have overspent your point budget.</p>
            )}

            <button
                onClick={onAdvance}
                disabled={!allocation.isValid}
                className={`w-full py-2 rounded text-[11px] uppercase tracking-widest transition-colors ${allocation.isValid ? 'bg-terminal/20 text-terminal hover:bg-terminal/30' : 'bg-void-dark/50 text-void-dark/30 cursor-not-allowed'}`}
            >
                Review Character
            </button>
        </div>
    );
}

export function ReviewStep({ answers, stats, budget, allocation, isOP, selectedArchetype, onCommit, isGenerating, onBack }: {
    answers: QuestionAnswers;
    stats: StatBlock;
    budget: 'NORMAL' | 'OP';
    allocation: { pointsSpent: number; pointsRemaining: number; isValid: boolean };
    isOP: boolean;
    selectedArchetype: Archetype | null;
    onCommit: () => void;
    isGenerating: boolean;
    onBack: () => void;
}) {
    const tier = getPCTier(isOP);
    return (
        <div className="space-y-4">
            <p className="text-[10px] uppercase tracking-widest text-text-dim">Review your character</p>

            <div className="bg-void-dark/50 border border-border/50 rounded p-3 space-y-2">
                <div className="text-[13px] font-medium text-terminal">{answers.name || 'Adventurer'}</div>
                <div className="text-[11px] text-text-dim">
                    {answers.concept && <p>Concept: {answers.concept}</p>}
                    {selectedArchetype && <p>Archetype: {selectedArchetype} | Tier: {tier}</p>}
                    {answers.voice && <p>Voice: {answers.voice}</p>}
                    {answers.drives && <p>Drives: {answers.drives}</p>}
                </div>

                <div className="border-t border-border/30 pt-2 mt-2">
                    <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
                        {STAT_KEYS.map(key => (
                            <div key={key}>
                                <span className="text-text-dim">{key}:</span> <span className="text-text-bright">{stats[key]}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="text-[9px] text-text-dim">
                    Point buy: {allocation.pointsSpent}/{PC_POINT_BUY[budget].totalPoints} spent
                    {isOP && ' (OP mode: elite tier)'}
                </div>
            </div>

            <div className="flex gap-3">
                <button
                    onClick={onBack}
                    className="flex-1 py-2 rounded text-[11px] uppercase tracking-widest bg-void-dark/50 text-text-dim hover:text-text-bright transition-colors border border-border"
                >
                    Back
                </button>
                <button
                    onClick={onCommit}
                    disabled={isGenerating || !allocation.isValid}
                    className={`flex-1 py-2 rounded text-[11px] uppercase tracking-widest transition-colors ${!isGenerating && allocation.isValid ? 'bg-terminal/20 text-terminal hover:bg-terminal/30' : 'bg-void-dark/50 text-void-dark/30 cursor-not-allowed'}`}
                >
                    {isGenerating ? 'Creating...' : 'Create Character'}
                </button>
            </div>
        </div>
    );
}

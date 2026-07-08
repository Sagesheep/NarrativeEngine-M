import { useState, useMemo, useCallback } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import {
    PC_POINT_BUY,
    STAT_KEYS,
    getPointCost,
    validateAllocation,
    ARCHETYPE_PRESETS,
    CREATION_QUESTIONS,
    getPCTier,
    getPCBudget,
    buildCharacterProfileState,
    DEFAULT_STATS,
} from '../../services/engine/pcCreationScript';
import type { StatKey, CreationQuestion } from '../../services/engine/pcCreationScript';
import type { StatBlock, Archetype, ChatMessage, CharacterProfileState } from '../../types';
import { generatePCProfile } from '../../services/npc/npcGeneration';
import { WorldPrimerPanel } from './WorldPrimerPanel';
import { useBackHandler } from '../../hooks/useBackHandler';

type WizardStep = 'questions' | 'stats' | 'review';

export type PCCreationResult = {
    npcEntry: ReturnType<typeof generatePCProfile> extends Promise<infer T> ? T : never;
    characterProfile: CharacterProfileState;
};

type QuestionAnswers = Record<string, string>;

export function PCCreationWizard({ onComplete, onCancel }: {
    onComplete: (result: PCCreationResult) => void;
    onCancel: () => void;
}) {
    const {
        addNPC,
        getActiveAuxiliaryEndpoint,
        npcLedger,
        activeCampaignId,
        loreChunks,
    } = useAppStore(useShallow(s => ({
        addNPC: s.addNPC,
        getActiveAuxiliaryEndpoint: s.getActiveAuxiliaryEndpoint,
        npcLedger: s.npcLedger,
        activeCampaignId: s.activeCampaignId,
        loreChunks: s.loreChunks,
    })));

    const [step, setStep] = useState<WizardStep>('questions');
    const [answers, setAnswers] = useState<QuestionAnswers>({});
    const [isOP, setIsOP] = useState(false);
    const [budget, setBudget] = useState<'NORMAL' | 'OP'>('NORMAL');
    const [stats, setStats] = useState<StatBlock>({ ...DEFAULT_STATS });
    const [selectedArchetype, setSelectedArchetype] = useState<Archetype | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [showPrimer, setShowPrimer] = useState(false);
    const [suggestingField, setSuggestingField] = useState<string | null>(null);

    // Back cancels the wizard. When the World Primer sub-panel is open, its own
    // handler (mounted on top) takes back first, so this one stays inactive.
    useBackHandler(!showPrimer, onCancel);

    const auxProvider = getActiveAuxiliaryEndpoint();

    const allocation = useMemo(() => validateAllocation(stats, budget), [stats, budget]);

    const handleAnswerChange = useCallback((field: string, value: string) => {
        setAnswers(prev => ({ ...prev, [field]: value }));
    }, []);

    const handleStatChange = useCallback((key: StatKey, delta: number) => {
        setStats(prev => {
            const cfg = PC_POINT_BUY[budget];
            const newVal = Math.max(cfg.min, Math.min(cfg.max, prev[key] + delta));
            return { ...prev, [key]: newVal };
        });
    }, [budget]);

    const handleArchetypePreset = useCallback((archetype: Archetype) => {
        setSelectedArchetype(archetype);
        setStats({ ...ARCHETYPE_PRESETS[archetype] });
    }, []);

    const handleOPToggle = useCallback(() => {
        const nextOP = !isOP;
        setIsOP(nextOP);
        setBudget(getPCBudget(nextOP));
    }, [isOP]);

    const canAdvanceToStats = !!answers.name && !!answers.archetype;

    const handleSuggest = useCallback(async (questionId: string) => {
        if (!auxProvider) return;
        setSuggestingField(questionId);
        try {
            const { llmCall } = await import('../../utils/llmCall');
            const loreContext = loreChunks.slice(0, 5).map(c => c.content).join('\n\n');
            const question = CREATION_QUESTIONS.find(q => q.id === questionId);
            if (!question) return;
            const prompt = `Based on the following world lore, suggest a brief answer for: "${question.prompt}"\n\nWorld Lore:\n${loreContext || 'No lore available.'}\n\nProvide just the answer text, nothing else. Keep it to 1-2 sentences.`;
            const result = await llmCall(auxProvider, prompt, { priority: 'low' });
            if (result) {
                setAnswers(prev => ({ ...prev, [questionId]: (prev[questionId] || '') + result.trim() }));
            }
        } catch (e) {
            console.warn('[PC Creation] Suggest failed:', e);
        } finally {
            setSuggestingField(null);
        }
    }, [auxProvider, loreChunks]);

    const handleFullAuto = useCallback(async () => {
        if (!auxProvider) return;
        setIsGenerating(true);
        try {
            const { llmCall } = await import('../../utils/llmCall');
            const loreContext = loreChunks.slice(0, 5).map(c => c.content).join('\n\n');
            const concept = answers.concept || answers.name || 'A mysterious wanderer';
            const prompt = `Create a brief character concept for a player character named "${answers.name || 'Unknown'}" with archetype "${answers.archetype || 'skirmisher'}". ${concept ? `Concept: ${concept}.` : ''}\n\nWorld context:\n${loreContext || 'A fantasy world.'}\n\nRespond with just the description text (2-3 sentences each) for: concept, voice, and drives.`;
            const result = await llmCall(auxProvider, prompt, { priority: 'low' });
            if (result) {
                const lines = result.trim().split('\n').filter(Boolean);
                if (!answers.concept && lines[0]) setAnswers(prev => ({ ...prev, concept: lines[0] }));
                if (!answers.voice && lines[1]) setAnswers(prev => ({ ...prev, voice: lines[1] }));
                if (!answers.drives && lines[2]) setAnswers(prev => ({ ...prev, drives: lines[2] }));
            }
        } catch (e) {
            console.warn('[PC Creation] Full auto failed:', e);
        } finally {
            setIsGenerating(false);
        }
    }, [auxProvider, loreChunks, answers]);

    const handleCommit = useCallback(async () => {
        if (!selectedArchetype) return;
        setIsGenerating(true);
        try {
            const questionnaireHistory: ChatMessage[] = CREATION_QUESTIONS.map(q => ({
                id: `q-${q.id}`,
                role: 'user' as const,
                content: `${q.prompt} ${answers[q.id] || '(not provided)'}`,
                timestamp: Date.now(),
            }));

            const overrides = {
                stats: allocation.stats,
                isOP,
                archetype: selectedArchetype,
                concept: answers.concept,
                playstyle: answers.playstyle,
                voice: answers.voice,
                drives: answers.drives,
            };

            let pcEntry;
            if (auxProvider) {
                pcEntry = await generatePCProfile(
                    auxProvider,
                    questionnaireHistory,
                    answers.name || 'Adventurer',
                    overrides,
                    addNPC,
                    npcLedger,
                    activeCampaignId ?? undefined,
                );
            } else {
                const { uid } = await import('../../utils/uid');
                const combatTier = getPCTier(isOP);
                pcEntry = {
                    id: uid(),
                    name: answers.name || 'Adventurer',
                    aliases: '',
                    status: 'Alive' as const,
                    faction: 'Unknown',
                    storyRelevance: answers.concept || 'A new adventurer',
                    appearance: '',
                    disposition: 'Neutral',
                    goals: 'Unknown',
                    voice: answers.voice || '',
                    personality: '',
                    exampleOutput: '',
                    affinity: 50,
                    drives: {
                        coreWant: answers.drives || 'To prove their worth',
                        sessionWant: 'To find their place in the world',
                        sceneWant: 'To make a first impression',
                    },
                    tier: 'recurring' as const,
                    isPC: true,
                    combatTier,
                    archetype: selectedArchetype,
                    stats: overrides.stats,
                    condition: 'healthy' as const,
                    fieldTags: {
                        voice: ['relationship_shift', 'revelation', 'other'],
                        hardBoundaries: ['relationship_shift', 'promise', 'betrayal'],
                        softBoundaries: ['relationship_shift', 'betrayal'],
                        behavioralTriggers: ['combat', 'relationship_shift', 'revelation'],
                        exampleOutput: ['relationship_shift', 'other'],
                        combatTier: ['combat'],
                        archetype: ['combat', 'discovery'],
                        stats: ['combat'],
                        drift: ['relationship_shift', 'revelation'],
                        innerState: ['relationship_shift', 'revelation', 'discovery'],
                    } as Record<string, import('../../types').SceneEventType[]>,
                };
                addNPC(pcEntry);
            }

            const profileState = buildCharacterProfileState({
                name: pcEntry.name,
                concept: answers.concept,
                playstyle: answers.playstyle,
                voice: answers.voice,
                drives: answers.drives,
                stats: allocation.stats,
                archetype: selectedArchetype,
                isOP,
            });

            onComplete({ npcEntry: pcEntry, characterProfile: profileState });
        } catch (err) {
            console.error('[PC Creation] Commit failed:', err);
        } finally {
            setIsGenerating(false);
        }
    }, [allocation, answers, addNPC, auxProvider, isOP, npcLedger, activeCampaignId, selectedArchetype, onComplete]);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-void/80 backdrop-blur-sm p-4">
            <div className="bg-surface border border-border shadow-2xl rounded-lg w-full max-w-2xl max-h-[calc(85*var(--app-vh))] flex flex-col overflow-hidden">
                {/* Header */}
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h2 className="text-[13px] font-medium text-terminal uppercase tracking-widest">Create Your Character</h2>
                    <button onClick={onCancel} className="text-text-dim hover:text-text-bright transition-colors text-lg leading-none">&times;</button>
                </div>

                {/* Step indicator */}
                <div className="px-4 py-2 border-b border-border/50 flex gap-4 text-[10px] uppercase tracking-widest">
                    <button onClick={() => setStep('questions')} className={`${step === 'questions' ? 'text-terminal' : 'text-text-dim hover:text-text-bright'} transition-colors`}>
                        1. Story
                    </button>
                    <button onClick={() => canAdvanceToStats && setStep('stats')} className={`${step === 'stats' ? 'text-terminal' : canAdvanceToStats ? 'text-text-dim hover:text-text-bright' : 'text-void-dark/30 cursor-not-allowed'} transition-colors`} disabled={!canAdvanceToStats}>
                        2. Stats
                    </button>
                    <button onClick={() => canAdvanceToStats && setStep('review')} className={`${step === 'review' ? 'text-terminal' : canAdvanceToStats ? 'text-text-dim hover:text-text-bright' : 'text-void-dark/30 cursor-not-allowed'} transition-colors`} disabled={!canAdvanceToStats}>
                        3. Review
                    </button>
                    {auxProvider && (
                        <button onClick={handleFullAuto} disabled={isGenerating} className="ml-auto text-terminal/60 hover:text-terminal transition-colors">
                            {isGenerating ? 'Generating...' : 'Generate for me'}
                        </button>
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                    {step === 'questions' && (
                        <QuestionsStep
                            answers={answers}
                            onAnswer={handleAnswerChange}
                            onSuggest={handleSuggest}
                            suggestingField={suggestingField}
                            auxAvailable={!!auxProvider}
                            onOpenPrimer={() => setShowPrimer(true)}
                            onAdvance={() => canAdvanceToStats && setStep('stats')}
                            canAdvance={canAdvanceToStats}
                        />
                    )}
                    {step === 'stats' && (
                        <StatsStep
                            stats={stats}
                            budget={budget}
                            allocation={allocation}
                            isOP={isOP}
                            selectedArchetype={selectedArchetype}
                            onStatChange={handleStatChange}
                            onArchetypePreset={handleArchetypePreset}
                            onOPToggle={handleOPToggle}
                            onAdvance={() => setStep('review')}
                        />
                    )}
                    {step === 'review' && (
                        <ReviewStep
                            answers={answers}
                            stats={stats}
                            budget={budget}
                            allocation={allocation}
                            isOP={isOP}
                            selectedArchetype={selectedArchetype}
                            onCommit={handleCommit}
                            isGenerating={isGenerating}
                            onBack={() => setStep('stats')}
                        />
                    )}
                </div>
            </div>

            {showPrimer && (
                <WorldPrimerPanel onClose={() => setShowPrimer(false)} />
            )}
        </div>
    );
}

function QuestionsStep({ answers, onAnswer, onSuggest, suggestingField, auxAvailable, onOpenPrimer, onAdvance, canAdvance }: {
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

function QuestionField({ question, value, onChange, onSuggest, suggesting, auxAvailable }: {
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

function StatsStep({ stats, budget, allocation, isOP, selectedArchetype, onStatChange, onArchetypePreset, onOPToggle, onAdvance }: {
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

function ReviewStep({ answers, stats, budget, allocation, isOP, selectedArchetype, onCommit, isGenerating, onBack }: {
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
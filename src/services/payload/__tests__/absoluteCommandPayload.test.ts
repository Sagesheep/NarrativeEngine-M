import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payloadBuilder';
import { buildAbsoluteCommandBlock, clampAbsoluteCommand, ABSOLUTE_COMMAND_MAX_CHARS } from '../../turn/absoluteCommand';
import { defaultContext } from '../../../store/slices/campaignSlice';
import { defaultSettings } from '../../../store/settingsMigration';

const base = () => ({
    settings: { ...defaultSettings, contextLimit: 8192 },
    context: defaultContext,
    history: [],
    userMessage: 'I open the door.',
    directorBrief: 'MANDATORY: the door is locked.',
});
const finalUser = (messages: ReturnType<typeof buildPayload>['messages']) => String(messages[messages.length - 1].content);

describe('Absolute Command block', () => {
    it('is empty for blank input and clamps long input', () => {
        expect(buildAbsoluteCommandBlock('   ')).toBe('');
        expect(buildAbsoluteCommandBlock(undefined)).toBe('');
        expect(clampAbsoluteCommand('x'.repeat(2000))).toHaveLength(ABSOLUTE_COMMAND_MAX_CHARS);
    });
});

describe('Absolute Command in the payload', () => {
    it('goes last, after the player message, and suppresses the Director Brief', () => {
        const text = finalUser(buildPayload({ ...base(), absoluteCommand: 'Skip to the next morning.' }).messages);
        expect(text.endsWith('COMMAND: Skip to the next morning.\n[END ABSOLUTE COMMAND]')).toBe(true);
        expect(text.indexOf('I open the door.')).toBeLessThan(text.indexOf('[USER ABSOLUTE COMMAND'));
        expect(text).not.toContain('[DIRECTOR BRIEF]');
        expect(text).not.toContain('[GM REMINDER');
    });

    it('a normal turn is unchanged', () => {
        const text = finalUser(buildPayload(base()).messages);
        expect(text).toContain('[DIRECTOR BRIEF]');
        expect(text).not.toContain('[GM REMINDER');
        expect(text).not.toContain('ABSOLUTE COMMAND');
        expect(text.endsWith('I open the door.')).toBe(true);
    });
});

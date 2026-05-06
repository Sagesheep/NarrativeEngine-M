import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EngineTraceView } from '../../engine-trace/EngineTraceView';

describe('EngineTraceView', () => {
    it('renders with empty payload', () => {
        const { container } = render(<EngineTraceView payload={[]} />);
        expect(container.textContent).toContain('Engine Trace Data');
    });

    it('renders system context and history sections', () => {
        const payload = [
            { role: 'system', content: 'You are a GM' },
            { role: 'assistant', content: 'The goblin appears' },
            { role: 'user', content: 'I attack the goblin' },
        ];
        const { container } = render(<EngineTraceView payload={payload} />);
        expect(container.textContent).toContain('System Context');
        expect(container.textContent).toContain('History');
        expect(container.textContent).toContain('This Turn');
    });

    it('renders null payload gracefully', () => {
        const { container } = render(<EngineTraceView payload={null} />);
        expect(container.textContent).toContain('Engine Trace Data');
    });

    it('renders with user and assistant messages', () => {
        const payload = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Welcome' },
        ];
        const { container } = render(<EngineTraceView payload={payload} />);
        expect(container.textContent).toContain('This Turn');
    });
});
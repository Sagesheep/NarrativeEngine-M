import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NPCUpdateRequestModal } from '../NPCUpdateRequestModal';
import type { RequestedUpdateResult, UpdateProposal } from '../../../services/npc/npcRequestedUpdate';

const proposal = (field: UpdateProposal['field'], before: string, after: string): UpdateProposal =>
    ({ field, label: field, before, after, value: after, source: 'your request' });

function setup(result: RequestedUpdateResult | Error) {
    const onPropose = vi.fn(async () => { if (result instanceof Error) throw result; return result; });
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<NPCUpdateRequestModal open npcName="Makoto" isPC onPropose={onPropose} onApply={onApply} onClose={onClose} />);
    return { onPropose, onApply, onClose };
}

const typeRequest = (text: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });

describe('NPCUpdateRequestModal', () => {
    it('asks what changed, then applies only the fields the player keeps checked', async () => {
        const { onPropose, onApply } = setup({
            evidenceFound: false,
            proposals: [proposal('abilities', 'Orpheus', 'Pluto'), proposal('goals', 'Survive', 'Protect the dorm')],
        });
        expect(screen.getByText('What needs to be updated?')).toBeTruthy();
        typeRequest('My Persona is Pluto');
        fireEvent.click(screen.getByText(/Find & propose/));

        await waitFor(() => expect(screen.getByText('Pluto')).toBeTruthy());
        expect(onPropose).toHaveBeenCalledWith({ request: 'My Persona is Pluto', mode: 'story', strong: false });
        expect(screen.getByText(/No supporting scene found/)).toBeTruthy();

        const boxes = screen.getAllByRole('checkbox');
        fireEvent.click(boxes[1]); // untick goals
        fireEvent.click(screen.getByText('Apply 1'));
        expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ field: 'abilities' })]);
    });

    it('check recent chat runs with no request', async () => {
        const { onPropose, onApply } = setup({ evidenceFound: true, proposals: [] });
        fireEvent.click(screen.getByText(/Check recent chat/));
        await waitFor(() => expect(screen.getByText('No changes needed.')).toBeTruthy());
        expect(onPropose).toHaveBeenCalledWith({ request: '', mode: 'story', strong: false });
        expect(screen.queryByText(/No supporting scene found/)).toBeNull();
        expect(onApply).not.toHaveBeenCalled();
    });

    it('complete from canon defaults to the strong model and can run blank', async () => {
        const { onPropose } = setup({ evidenceFound: true, proposals: [], warning: 'No lore entry for this character' });
        fireEvent.click(screen.getByText('Complete from canon'));
        expect(screen.queryByText(/Check recent chat/)).toBeNull();
        fireEvent.click(screen.getByText(/^Complete$/));
        await waitFor(() => expect(screen.getByText(/No lore entry/)).toBeTruthy());
        expect(onPropose).toHaveBeenCalledWith({ request: '', mode: 'canon', strong: true });
    });

    it('the model switch is the player\'s call', async () => {
        const { onPropose } = setup({ evidenceFound: true, proposals: [] });
        fireEvent.click(screen.getByText('Strong'));
        typeRequest('lost his sword');
        fireEvent.click(screen.getByText(/Find & propose/));
        await waitFor(() => expect(onPropose).toHaveBeenCalledWith({ request: 'lost his sword', mode: 'story', strong: true }));
    });

    it('shows a failure and lets the player retry', async () => {
        const { onPropose } = setup(new Error('No AI endpoint configured.'));
        typeRequest('x');
        fireEvent.click(screen.getByText(/Find & propose/));
        await waitFor(() => expect(screen.getByText('No AI endpoint configured.')).toBeTruthy());
        fireEvent.click(screen.getByText(/Find & propose/));
        await waitFor(() => expect(onPropose).toHaveBeenCalledTimes(2));
    });
});

import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NPCEditForm } from '../NPCEditForm';
import type { NPCEntry } from '../../../types';

function Harness({ initial, editing = true }: { initial: Partial<NPCEntry>; editing?: boolean }) {
    const [form, setForm] = useState<Partial<NPCEntry>>(initial);
    return (
        <>
            <NPCEditForm
                form={form} setForm={setForm} selectedId="n1" isEditing={editing} isAIUpdating={false}
                onEdit={() => {}} onSave={() => {}} onCancel={() => {}} onDelete={() => {}} onAIUpdate={() => {}}
            />
            <output data-testid="kit">{JSON.stringify(form.signatureKit ?? null)}</output>
        </>
    );
}

const base: Partial<NPCEntry> = { id: 'n1', name: 'Rick', aliases: '' };
const kitState = () => JSON.parse(screen.getByTestId('kit').textContent ?? 'null');

describe('Signature Kit editor', () => {
    it('shows the stored kit', () => {
        render(<Harness initial={{ ...base, signatureKit: { equipment: ['Excalibur'], abilities: ['fire magic'], element: 'fire' } }} editing={false} />);
        expect(screen.getByText('Signature Kit')).toBeTruthy();
        expect(screen.getByDisplayValue('Excalibur')).toBeTruthy();
        expect(screen.getByDisplayValue('fire magic')).toBeTruthy();
        expect(screen.getByDisplayValue('fire')).toBeTruthy();
    });

    it('adds, edits and removes gear rows', () => {
        render(<Harness initial={base} />);
        fireEvent.click(screen.getAllByText('+ Add').find(b => b.closest('div')?.textContent?.includes('Equipment'))!);
        fireEvent.change(screen.getByPlaceholderText('e.g. Excalibur (holy longsword)'), { target: { value: 'iron spear' } });
        expect(kitState()).toMatchObject({ equipment: ['iron spear'], abilities: [] });
    });

    it('stops offering + Add at 8 entries', () => {
        const eight = Array.from({ length: 8 }, (_, i) => `item ${i}`);
        render(<Harness initial={{ ...base, signatureKit: { equipment: eight, abilities: [] } }} />);
        expect(screen.getByText('Equipment (8/8)')).toBeTruthy();
        const addButtons = screen.getAllByText('+ Add').filter(b => b.closest('div')?.textContent?.includes('Equipment ('));
        expect(addButtons).toHaveLength(0);
    });
});

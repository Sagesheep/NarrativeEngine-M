export function Toggle({ active, onChange }: { active: boolean; onChange: () => void }) {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onChange(); }}
            className={`relative w-11 h-6 md:w-7 md:h-3.5 rounded-full transition-colors shrink-0 ${active ? 'bg-terminal' : 'bg-border'}`}
            title={active ? 'Active — will be appended' : 'Inactive — will not be appended'}
        >
            <div
                className={`absolute top-0.5 md:top-0.5 h-5 w-5 md:h-2.5 md:w-2.5 rounded-full bg-surface transition-transform ${active ? 'translate-x-5 md:translate-x-3.5' : 'translate-x-0.5'}`}
            />
        </button>
    );
}

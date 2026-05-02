import { useEffect, useState, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';

type Props = {
    container: HTMLElement | null;
    onTrigger: (sel: { text: string; start: number; end: number }) => void;
};

const LONG_PRESS_MS = 500;

export function SelectionToolbar({ container, onTrigger }: Props) {
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const [pending, setPending] = useState<{ text: string; start: number; end: number } | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clear = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setPos(null);
        setPending(null);
    }, []);

    useEffect(() => {
        if (!container) return;

        const captureSelection = () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
            const range = sel.getRangeAt(0);
            if (!container.contains(range.commonAncestorContainer)) return null;
            const text = sel.toString().trim();
            if (text.length < 3) return null;
            const fullText = container.textContent ?? '';
            const start = fullText.indexOf(text);
            if (start === -1) return null;
            const end = start + text.length;
            const rect = range.getBoundingClientRect();
            return { text, start, end, rect };
        };

        const handleSelectionChange = () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            const result = captureSelection();
            if (!result) {
                setPos(null);
                setPending(null);
                return;
            }
            setPending({ text: result.text, start: result.start, end: result.end });
        };

        const startLongPress = () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                const result = captureSelection();
                if (!result) {
                    setPos(null);
                    setPending(null);
                    return;
                }
                setPos({ x: result.rect.left + result.rect.width / 2, y: result.rect.top - 8 });
                setPending({ text: result.text, start: result.start, end: result.end });
                timerRef.current = null;
            }, LONG_PRESS_MS);
        };

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            clear();
            startLongPress();
        };

        const onTouchStart = (_e: TouchEvent) => {
            clear();
            startLongPress();
        };

        const cancelPress = () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };

        const onMouseUp = () => cancelPress();
        const onTouchEnd = () => cancelPress();
        const onTouchMove = () => cancelPress();
        const onMouseMove = (e: MouseEvent) => {
            if (e.buttons === 0 && timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };

        document.addEventListener('selectionchange', handleSelectionChange);
        container.addEventListener('mousedown', onMouseDown);
        container.addEventListener('touchstart', onTouchStart, { passive: true });
        container.addEventListener('mouseup', onMouseUp);
        container.addEventListener('touchend', onTouchEnd);
        container.addEventListener('touchmove', onTouchMove, { passive: true });
        container.addEventListener('mousemove', onMouseMove);

        return () => {
            document.removeEventListener('selectionchange', handleSelectionChange);
            container.removeEventListener('mousedown', onMouseDown);
            container.removeEventListener('touchstart', onTouchStart);
            container.removeEventListener('mouseup', onMouseUp);
            container.removeEventListener('touchend', onTouchEnd);
            container.removeEventListener('touchmove', onTouchMove);
            container.removeEventListener('mousemove', onMouseMove);
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [container, clear]);

    if (!pos || !pending) return null;

    return (
        <button
            onMouseDown={(e) => {
                e.preventDefault();
                onTrigger(pending);
                setPos(null);
                setPending(null);
                window.getSelection()?.removeAllRanges();
            }}
            onTouchStart={(e) => {
                e.preventDefault();
                onTrigger(pending);
                setPos(null);
                setPending(null);
                window.getSelection()?.removeAllRanges();
            }}
            style={{
                position: 'fixed',
                left: pos.x,
                top: pos.y,
                transform: 'translate(-50%, -100%)',
                zIndex: 50,
            }}
            className="bg-void-darker border border-terminal text-terminal text-[10px] uppercase tracking-widest px-2 py-1 rounded shadow-lg flex items-center gap-1 hover:bg-terminal/10 active:bg-terminal/20"
            title="Lore Check"
        >
            <Search size={10} />
            Lore Check
        </button>
    );
}

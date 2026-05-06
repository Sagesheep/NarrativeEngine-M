import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

type OAIMsg = { role: string; content: string | null; name?: string };

const SystemMsgRow: React.FC<{ content: string | null }> = ({ content }) => {
    const [open, setOpen] = useState(false);
    const text = content || '';
    const preview = text.slice(0, 100).replace(/\n/g, ' ');
    return (
        <div>
            <button onClick={() => setOpen(p => !p)} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-terminal/5 text-left">
                {open ? <ChevronDown size={9} className="text-terminal/30 shrink-0" /> : <ChevronRight size={9} className="text-terminal/30 shrink-0" />}
                <span className="text-text-dim/40 truncate text-[8px]">{preview}{text.length > 100 ? '…' : ''}</span>
                <span className="ml-2 text-text-dim/30 shrink-0 text-[8px]">~{Math.round(text.length / 4)}t</span>
            </button>
            {open && (
                <div className="px-2 pb-2 text-[9px] text-text-dim/60 whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-void border-t border-terminal/5">
                    {text}
                </div>
            )}
        </div>
    );
};

const HistoryMsgRow: React.FC<{ msg: OAIMsg }> = ({ msg }) => {
    const [open, setOpen] = useState(false);
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) || '';
    const preview = text.slice(0, 80).replace(/\n/g, ' ');
    const roleColor = msg.role === 'user' ? 'text-terminal/50' : msg.role === 'tool' ? 'text-amber-400/50' : 'text-sky-400/50';
    const roleLabel = msg.role === 'user' ? 'YOU' : msg.role === 'tool' ? 'TOOL' : 'GM';
    return (
        <div>
            <button onClick={() => setOpen(p => !p)} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-terminal/5 text-left">
                {open ? <ChevronDown size={9} className="text-terminal/30 shrink-0" /> : <ChevronRight size={9} className="text-terminal/30 shrink-0" />}
                <span className={`text-[8px] font-bold shrink-0 ${roleColor}`}>{roleLabel}</span>
                <span className="text-text-dim/40 truncate ml-1 text-[8px]">{preview}{text.length > 80 ? '…' : ''}</span>
            </button>
            {open && (
                <div className="px-2 pb-2 text-[9px] text-text-dim/60 whitespace-pre-wrap break-words max-h-40 overflow-y-auto bg-void border-t border-terminal/5">
                    {text}
                </div>
            )}
        </div>
    );
};

export const EngineTraceView: React.FC<{ payload: unknown }> = ({ payload }) => {
    const messages = (payload as unknown as OAIMsg[]) || [];
    const [open, setOpen] = useState({ system: false, history: false, turn: true });
    const toggle = (k: keyof typeof open) => setOpen(p => ({ ...p, [k]: !p[k] }));

    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const lastUserIdx = nonSystem.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1);
    const splitIdx = lastUserIdx >= 0 ? lastUserIdx : Math.max(0, nonSystem.length - 1);
    const historyMsgs = nonSystem.slice(0, splitIdx);
    const thisTurnMsgs = nonSystem.slice(splitIdx);

    return (
        <div className="mt-3 border-t border-border/10 pt-3 font-mono text-[9px] space-y-1.5">
            <div className="text-[8px] text-text-dim/30 uppercase tracking-[0.3em] flex items-center gap-1.5 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                Engine Trace Data
            </div>

            <div className="border border-terminal/10 rounded overflow-hidden">
                <button onClick={() => toggle('system')} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-terminal/5 text-left">
                    {open.system ? <ChevronDown size={10} className="text-terminal/40 shrink-0" /> : <ChevronRight size={10} className="text-terminal/40 shrink-0" />}
                    <span className="text-terminal/50 uppercase tracking-widest">System Context</span>
                    <span className="ml-auto text-text-dim/30">{systemMsgs.length} msg{systemMsgs.length !== 1 ? 's' : ''}</span>
                </button>
                {open.system && (
                    <div className="border-t border-terminal/10 divide-y divide-terminal/5">
                        {systemMsgs.map((m, i) => <SystemMsgRow key={i} content={m.content} />)}
                    </div>
                )}
            </div>

            {historyMsgs.length > 0 && (
                <div className="border border-terminal/10 rounded overflow-hidden">
                    <button onClick={() => toggle('history')} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-terminal/5 text-left">
                        {open.history ? <ChevronDown size={10} className="text-terminal/40 shrink-0" /> : <ChevronRight size={10} className="text-terminal/40 shrink-0" />}
                        <span className="text-terminal/50 uppercase tracking-widest">Fitted History</span>
                        <span className="ml-auto text-text-dim/30">{historyMsgs.length} msg{historyMsgs.length !== 1 ? 's' : ''}</span>
                    </button>
                    {open.history && (
                        <div className="border-t border-terminal/10 divide-y divide-terminal/5">
                            {historyMsgs.map((m, i) => <HistoryMsgRow key={i} msg={m} />)}
                        </div>
                    )}
                </div>
            )}

            {thisTurnMsgs.length > 0 && (
                <div className="border border-terminal/10 rounded overflow-hidden">
                    <button onClick={() => toggle('turn')} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-terminal/5 text-left">
                        {open.turn ? <ChevronDown size={10} className="text-terminal/40 shrink-0" /> : <ChevronRight size={10} className="text-terminal/40 shrink-0" />}
                        <span className="text-terminal/50 uppercase tracking-widest">This Turn</span>
                        <span className="ml-auto text-text-dim/30">{thisTurnMsgs.length} msg{thisTurnMsgs.length !== 1 ? 's' : ''}</span>
                    </button>
                    {open.turn && (
                        <div className="border-t border-terminal/10 divide-y divide-terminal/5">
                            {thisTurnMsgs.map((m, i) => <HistoryMsgRow key={i} msg={m} />)}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

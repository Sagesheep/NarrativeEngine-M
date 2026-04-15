export type LLMCallPriority = 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<LLMCallPriority, number> = { high: 2, normal: 1, low: 0 };

type Waiter = { priority: LLMCallPriority; wake: () => void };

export class LLMRequestQueue {
    private inflight = 0;
    private maxConcurrent = Infinity;
    private queue: Waiter[] = [];
    private lastFireTime = 0;
    private readonly staggerMs: number;
    private scheduled = false;

    constructor(staggerMs = 500) {
        this.staggerMs = staggerMs;
    }

    acquireSlot(priority: LLMCallPriority = 'normal'): Promise<void> {
        return new Promise<void>(resolve => {
            const waiter: Waiter = {
                priority,
                wake: () => { this.inflight++; resolve(); },
            };
            const idx = this.queue.findIndex(
                w => PRIORITY_ORDER[w.priority] < PRIORITY_ORDER[priority]
            );
            if (idx === -1) this.queue.push(waiter);
            else this.queue.splice(idx, 0, waiter);

            this.scheduleDrain();
        });
    }

    releaseSlot(): void {
        this.inflight = Math.max(0, this.inflight - 1);
        this.scheduleDrain();
    }

    onRateLimitHit(): void {
        const cap = Math.max(1, this.inflight - 1);
        if (cap < this.maxConcurrent) {
            this.maxConcurrent = cap;
            console.warn(
                `[LLMQueue] 429 rate limit — concurrency cap set to ${this.maxConcurrent}`
            );
        }
    }

    private scheduleDrain(): void {
        if (this.scheduled) return;
        if (this.queue.length === 0 || this.inflight >= this.maxConcurrent) return;

        const sinceLastFire = Date.now() - this.lastFireTime;
        const delay = Math.max(0, this.staggerMs - sinceLastFire);

        this.scheduled = true;
        setTimeout(() => {
            this.scheduled = false;
            if (this.queue.length > 0 && this.inflight < this.maxConcurrent) {
                const waiter = this.queue.shift()!;
                this.lastFireTime = Date.now();
                waiter.wake();
                this.scheduleDrain();
            }
        }, delay);
    }
}

export const llmQueue = new LLMRequestQueue();

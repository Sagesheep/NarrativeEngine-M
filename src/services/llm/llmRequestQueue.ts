export type LLMCallPriority = 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<LLMCallPriority, number> = { high: 2, normal: 1, low: 0 };

const RECOVERY_WINDOW_MS = 60_000;
const INFINITY_RECOVERY_CAP = 10;

type Waiter = { priority: LLMCallPriority; wake: () => void };

export class LLMRequestQueue {
    private inflight = 0;
    private maxConcurrent: number;
    private readonly initialMaxConcurrent: number;
    private queue: Waiter[] = [];
    private lastFireTime = 0;
    private readonly staggerMs: number;
    private scheduled = false;
    private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(staggerMs = 500, maxConcurrentOverride?: number) {
        this.staggerMs = staggerMs;
        this.maxConcurrent = maxConcurrentOverride ?? Infinity;
        this.initialMaxConcurrent = this.maxConcurrent;
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
                `[LLMQueue] Rate limit — concurrency cap reduced to ${this.maxConcurrent}`
            );
        }
        this.scheduleRecovery();
    }

    private scheduleRecovery(): void {
        if (this.initialMaxConcurrent <= 1) return;
        if (this.maxConcurrent >= this.initialMaxConcurrent) return;

        if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);

        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;

            if (this.initialMaxConcurrent === Infinity && this.maxConcurrent >= INFINITY_RECOVERY_CAP) {
                this.maxConcurrent = Infinity;
                console.log(`[LLMQueue] Concurrency cap fully restored (unbounded)`);
                this.scheduleDrain();
                return;
            }

            this.maxConcurrent += 1;
            console.log(`[LLMQueue] Concurrency cap recovered to ${this.maxConcurrent}`);
            this.scheduleDrain();

            if (this.maxConcurrent < this.initialMaxConcurrent) this.scheduleRecovery();
        }, RECOVERY_WINDOW_MS);
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

export function normalizeEndpointKey(raw: string): string {
    const s = raw.trim();
    if (!s) return '__fallback__';
    try {
        const u = new URL(s.includes('://') ? s : 'http://' + s);
        return `${u.protocol}//${u.host}`.toLowerCase();
    } catch {
        return s.toLowerCase();
    }
}

export function isLocalEndpoint(raw: string): boolean {
    try {
        const u = new URL(raw.includes('://') ? raw : 'http://' + raw);
        const h = u.hostname;
        return (
            h === 'localhost' ||
            h === '127.0.0.1' ||
            h === '::1' ||
            /^127\./.test(h) ||
            /^10\./.test(h) ||
            /^192\.168\./.test(h) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(h)
        );
    } catch {
        return false;
    }
}

const _endpointQueues = new Map<string, LLMRequestQueue>();

export function getQueueForEndpoint(endpoint: string): LLMRequestQueue {
    const key = normalizeEndpointKey(endpoint);
    if (!_endpointQueues.has(key)) {
        const local = isLocalEndpoint(endpoint);
        const q = local ? new LLMRequestQueue(500, 1) : new LLMRequestQueue(500);
        console.log(`[LLMQueue] New queue for "${key}" — ${local ? 'local (maxConcurrent=1)' : 'cloud (unbounded)'}`);
        _endpointQueues.set(key, q);
    }
    return _endpointQueues.get(key)!;
}

export const llmQueue = getQueueForEndpoint('__legacy__');
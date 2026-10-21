import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { thinkingHostOf, type CatalogModel } from '../../utils/thinkingControl';
import type { ServiceTier } from '../../types';

/**
 * Per-model thinking options from hosts that publish them, read by
 * thinkingControl to pick how a model turns thinking off and which effort
 * levels it accepts:
 * - NanoGPT: `capabilities.reasoning` and `reasoning_efforts` on /models?detailed=true
 * - OpenRouter: `reasoning` (mandatory, default_enabled, supported_efforts) on /models
 *
 * Also the service tiers each model offers: NanoGPT's `supported_service_tiers`
 * on the same list, OpenRouter's `service_tier` on each of the model's
 * /models/{id}/endpoints (fetched per model, on demand, kept in memory).
 *
 * Both lists are public. Each is fetched at most once a day and kept in
 * IndexedDB in a compact form (~30 KB). A request waits briefly for the first
 * fetch, then goes ahead without it.
 */

type CatalogHost = 'nanogpt' | 'openrouter';

interface CatalogRecord {
    fetchedAt: number;
    models: Record<string, CatalogModel>;
    /** Parser version; a stored list from an older one is refreshed. */
    version?: number;
}

// 2: service tiers.
const CATALOG_VERSION = 2;

const TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_MS = 4000;

const catalogs = new Map<CatalogHost, CatalogRecord>();
const loading = new Map<CatalogHost, Promise<void>>();
const lastFailure = new Map<CatalogHost, number>();

function catalogHostOf(endpoint: string): CatalogHost | null {
    const host = thinkingHostOf(endpoint);
    return host === 'nanogpt' || host === 'openrouter' ? host : null;
}

function catalogUrl(host: CatalogHost, endpoint: string): string {
    const origin = new URL(endpoint.trim()).origin;
    return host === 'nanogpt' ? `${origin}/api/v1/models?detailed=true` : `${origin}/api/v1/models`;
}

const idbKey = (host: CatalogHost) => `modelCatalog:${host}`;

type RawModel = Record<string, unknown>;

function rawModels(data: unknown): RawModel[] {
    const list = (data as { data?: unknown })?.data;
    return Array.isArray(list) ? list.filter((m): m is RawModel => !!m && typeof m === 'object') : [];
}

function stringList(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const list = v.filter((s): s is string => typeof s === 'string');
    return list.length ? list : undefined;
}

/** Host tier names as the app's: `fast` is NanoGPT's name for priority. Others are dropped. */
export function parseServiceTiers(v: unknown): ServiceTier[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const tiers = new Set<ServiceTier>();
    for (const t of v) {
        const name = typeof t === 'string' ? t.toLowerCase() : '';
        if (name === 'flex') tiers.add('flex');
        else if (name === 'fast' || name === 'priority') tiers.add('priority');
    }
    return [...tiers];
}

export function parseNanoGptCatalog(data: unknown): Record<string, CatalogModel> {
    const models: Record<string, CatalogModel> = {};
    for (const m of rawModels(data)) {
        if (typeof m.id !== 'string') continue;
        const capabilities = m.capabilities as { reasoning?: unknown } | undefined;
        const entry: CatalogModel = { reasoning: capabilities?.reasoning === true };
        const efforts = stringList(m.reasoning_efforts);
        if (efforts) entry.efforts = efforts;
        const tiers = parseServiceTiers(m.supported_service_tiers);
        if (tiers) entry.serviceTiers = tiers;
        models[m.id.toLowerCase()] = entry;
        for (const alias of stringList(m.aliases) ?? []) {
            models[alias.toLowerCase()] ??= entry;
        }
    }
    return models;
}

export function parseOpenRouterCatalog(data: unknown): Record<string, CatalogModel> {
    const models: Record<string, CatalogModel> = {};
    for (const m of rawModels(data)) {
        if (typeof m.id !== 'string') continue;
        const reasoning = m.reasoning as { mandatory?: unknown; default_enabled?: unknown; supported_efforts?: unknown } | null | undefined;
        const params = stringList(m.supported_parameters) ?? [];
        const entry: CatalogModel = { reasoning: Boolean(reasoning) || params.includes('reasoning') };
        if (reasoning) {
            if (reasoning.mandatory === true) entry.mandatory = true;
            if (typeof reasoning.default_enabled === 'boolean') entry.defaultOn = reasoning.default_enabled;
            const efforts = stringList(reasoning.supported_efforts);
            if (efforts) entry.efforts = efforts;
        }
        models[m.id.toLowerCase()] = entry;
    }
    return models;
}

async function fetchJson(url: string): Promise<unknown> {
    if (Capacitor.isNativePlatform()) {
        const res = await CapacitorHttp.get({ url, headers: { Accept: 'application/json' }, connectTimeout: 15000, readTimeout: 30000 });
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
        return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    }
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function readStored(host: CatalogHost): Promise<void> {
    if (catalogs.has(host)) return;
    try {
        const stored = await idbGet<CatalogRecord>(idbKey(host));
        if (stored?.models && !catalogs.has(host)) catalogs.set(host, stored);
    } catch { /* no IndexedDB: fetch instead */ }
}

function refresh(host: CatalogHost, endpoint: string): Promise<void> {
    const pending = loading.get(host);
    if (pending) return pending;
    const run = (async () => {
        try {
            const data = await fetchJson(catalogUrl(host, endpoint));
            const models = host === 'nanogpt' ? parseNanoGptCatalog(data) : parseOpenRouterCatalog(data);
            if (Object.keys(models).length === 0) throw new Error('empty model list');
            const record: CatalogRecord = { fetchedAt: Date.now(), models, version: CATALOG_VERSION };
            catalogs.set(host, record);
            lastFailure.delete(host);
            try { await idbSet(idbKey(host), record); } catch { /* memory copy is enough */ }
        } catch (err) {
            lastFailure.set(host, Date.now());
            console.warn(`[modelCatalog] ${host} model list unavailable (${err instanceof Error ? err.message : err}); using default thinking controls`);
        }
    })().finally(() => loading.delete(host));
    loading.set(host, run);
    return run;
}

/**
 * Makes the host's model list available to lookupCatalogModel. Returns at once
 * for other hosts or a fresh list; a stored list older than a day is used while
 * a new one downloads; with none it waits up to `waitMs` for the first fetch.
 */
export async function ensureModelCatalog(endpoint: string, waitMs = DEFAULT_WAIT_MS): Promise<void> {
    const host = catalogHostOf(endpoint);
    if (!host) return;
    await readStored(host);
    const current = catalogs.get(host);
    if (current && current.version === CATALOG_VERSION && Date.now() - current.fetchedAt < TTL_MS) return;
    const failedAt = lastFailure.get(host);
    if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return;
    const load = refresh(host, endpoint);
    if (current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([load, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
}

/** The model's entry in its host's list, or undefined when unknown. */
export function lookupCatalogModel(endpoint: string, modelId: string): CatalogModel | undefined {
    const host = catalogHostOf(endpoint);
    if (!host) return undefined;
    const models = catalogs.get(host)?.models;
    if (!models) return undefined;
    const id = modelId.trim().toLowerCase();
    const exact = models[id];
    if (exact || host !== 'openrouter') return exact;
    // OpenRouter routing suffixes (:free, :nitro, :floor...) share the base model's options.
    const colon = id.indexOf(':');
    return colon > 0 ? models[id.slice(0, colon)] : undefined;
}

// ── OpenRouter service tiers, per model ────────────────────────────────────
const openRouterTiers = new Map<string, ServiceTier[]>();
const openRouterTierLoads = new Map<string, Promise<void>>();

/** OpenRouter's base model id: routing suffixes (:nitro, :floor...) share its endpoints. */
function openRouterBaseId(modelId: string): string {
    const id = modelId.trim().toLowerCase();
    const colon = id.indexOf(':');
    return colon > 0 ? id.slice(0, colon) : id;
}

export function parseOpenRouterEndpoints(data: unknown): ServiceTier[] | undefined {
    const endpoints = (data as { data?: { endpoints?: unknown } })?.data?.endpoints;
    if (!Array.isArray(endpoints)) return undefined;
    return parseServiceTiers(endpoints.map(e => (e as { service_tier?: unknown } | null)?.service_tier));
}

/**
 * Downloads which tiers an OpenRouter model's endpoints offer, once per model
 * per session, waiting up to `waitMs`. Does nothing for other hosts; a failure
 * leaves the model unknown.
 */
export async function ensureOpenRouterServiceTiers(endpoint: string, modelId: string, waitMs = DEFAULT_WAIT_MS): Promise<void> {
    if (catalogHostOf(endpoint) !== 'openrouter' || !modelId.trim()) return;
    const id = openRouterBaseId(modelId);
    if (openRouterTiers.has(id)) return;
    let run = openRouterTierLoads.get(id);
    if (!run) {
        run = loadOpenRouterTiers(endpoint, id);
        openRouterTierLoads.set(id, run);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
}

function loadOpenRouterTiers(endpoint: string, id: string): Promise<void> {
    return (async () => {
        try {
            const origin = new URL(endpoint.trim()).origin;
            const tiers = parseOpenRouterEndpoints(await fetchJson(`${origin}/api/v1/models/${id}/endpoints`));
            if (tiers) openRouterTiers.set(id, tiers);
        } catch (err) {
            console.warn(`[modelCatalog] OpenRouter endpoints for ${id} unavailable (${err instanceof Error ? err.message : err})`);
        }
    })().finally(() => openRouterTierLoads.delete(id));
}

/**
 * The service tiers a model offers besides the default ([] = default only), or
 * undefined when the host has not said (not loaded yet, or not listed).
 */
export function lookupServiceTiers(endpoint: string, modelId: string): ServiceTier[] | undefined {
    const host = catalogHostOf(endpoint);
    if (host === 'openrouter') return openRouterTiers.get(openRouterBaseId(modelId));
    if (host === 'nanogpt') return lookupCatalogModel(endpoint, modelId)?.serviceTiers;
    return undefined;
}

export function __setOpenRouterTiersForTests(modelId: string, tiers: ServiceTier[] | null): void {
    if (tiers) openRouterTiers.set(openRouterBaseId(modelId), tiers);
    else openRouterTiers.delete(openRouterBaseId(modelId));
}

export function __setModelCatalogForTests(host: CatalogHost, models: Record<string, CatalogModel> | null): void {
    if (models) catalogs.set(host, { fetchedAt: Date.now(), models, version: CATALOG_VERSION });
    else catalogs.delete(host);
    loading.delete(host);
    lastFailure.delete(host);
}

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { set as idbSet } from 'idb-keyval';
import { __setModelCatalogForTests, ensureModelCatalog, lookupCatalogModel } from '../modelCatalog';

const NANO_URL = 'https://nano-gpt.com/api/v1';
const LIST = {
    data: [{ id: 'deepseek/deepseek-v4-flash', capabilities: { reasoning: true }, reasoning_efforts: ['none', 'high', 'max'] }],
};

describe('ensureModelCatalog', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        __setModelCatalogForTests('nanogpt', null);
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        __setModelCatalogForTests('nanogpt', null);
    });

    it('downloads the NanoGPT list once and serves lookups from it', async () => {
        await idbSet('modelCatalog:nanogpt', undefined);
        fetchMock.mockResolvedValue(new Response(JSON.stringify(LIST), { status: 200 }));

        await ensureModelCatalog(NANO_URL);
        expect(fetchMock).toHaveBeenCalledWith('https://nano-gpt.com/api/v1/models?detailed=true', expect.anything());
        expect(lookupCatalogModel(NANO_URL, 'DeepSeek/DeepSeek-V4-Flash')).toEqual({ reasoning: true, efforts: ['none', 'high', 'max'] });

        await ensureModelCatalog(NANO_URL);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uses a stored list older than a day while a new one downloads', async () => {
        await idbSet('modelCatalog:nanogpt', { fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, models: { 'old/model': { reasoning: false } } });
        let release: (r: Response) => void = () => {};
        fetchMock.mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));

        await ensureModelCatalog(NANO_URL, 10_000);
        expect(lookupCatalogModel(NANO_URL, 'old/model')).toEqual({ reasoning: false });

        release(new Response(JSON.stringify(LIST), { status: 200 }));
        await vi.waitFor(() => expect(lookupCatalogModel(NANO_URL, 'deepseek/deepseek-v4-flash')).toBeDefined());
    });

    it('goes ahead without a list when the download fails', async () => {
        await idbSet('modelCatalog:nanogpt', undefined);
        fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
        await ensureModelCatalog(NANO_URL);
        expect(lookupCatalogModel(NANO_URL, 'deepseek/deepseek-v4-flash')).toBeUndefined();
    });

    it('does nothing for hosts without a list', async () => {
        await ensureModelCatalog('https://api.deepseek.com/v1');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

import type { SemanticFact } from '../../types';
import { getList, setList, k } from './_helpers';

export const factStorage = {
    async get(cid: string): Promise<SemanticFact[]> {
        return getList(k(cid, 'facts'));
    },
    async save(cid: string, facts: SemanticFact[]): Promise<void> {
        await setList(k(cid, 'facts'), facts);
    },
};

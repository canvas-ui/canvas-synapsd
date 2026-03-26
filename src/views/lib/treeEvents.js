'use strict';

export function buildTreeEventPayload(tree, payload = {}) {
    return {
        treeId: tree?.id ?? null,
        treeName: tree?.name ?? null,
        treeType: tree?.type ?? null,
        timestamp: payload.timestamp ?? new Date().toISOString(),
        ...payload,
    };
}

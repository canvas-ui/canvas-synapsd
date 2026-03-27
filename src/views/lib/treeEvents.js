'use strict';

import { createTreeEvent } from '../../utils/events.js';

export function buildTreeEventPayload(tree, eventName, payload = {}) {
    return createTreeEvent(eventName, tree, payload);
}

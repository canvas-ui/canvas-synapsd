'use strict';

import {
    parseISO,
    isToday,
    isYesterday,
    isThisWeek,
    isThisISOWeek,
    isThisMonth,
    isThisQuarter,
    isThisYear,
} from 'date-fns';

export default class TimestampIndex {

    constructor(store, cache = new Map()) {
        if (!store) { throw new Error('A Map() like store reference required'); }
        this.store = store;
        this.cache = cache;
    }

    static isWithinTimeFrame(dateString, timeFrameIdentifier) {
        const date = parseISO(dateString);
        const timeFrameChecks = {
            today: isToday,
            yesterday: isYesterday,
            thisWeek: isThisWeek,
            thisISOWeek: isThisISOWeek,
            thisMonth: isThisMonth,
            thisQuarter: isThisQuarter,
            thisYear: isThisYear,
        };

        return timeFrameChecks[timeFrameIdentifier]?.(date) ?? false;
    }

}

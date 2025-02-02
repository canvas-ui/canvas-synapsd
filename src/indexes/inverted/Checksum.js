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

export default class ChecksumIndex {

    constructor(store, cache = new Map()) {
        if (!store) { throw new Error('A Map() like store reference required'); }
        this.store = store;
        this.cache = cache;
    }

}

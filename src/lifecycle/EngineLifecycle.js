import { EVENTS, createEvent } from '../utils/events.js';

// Serializes transitions independently of document writes. The close callback
// first stops write admission and drains accepted work before closing storage.
export default class EngineLifecycle {
    #status = 'initializing';
    #tail = Promise.resolve();
    #closePending = false;
    #initialize; #close; #publish;
    constructor({ initialize, close, publish }) {
        this.#initialize = initialize;
        this.#close = close;
        this.#publish = publish;
    }
    get status() { return this.#status; }
    #enqueue(action) {
        const result = this.#tail.then(action);
        this.#tail = result.catch(() => {});
        return result;
    }
    start() { return this.#enqueue(() => this.#start()); }
    shutdown() { return this.#enqueue(() => this.#shutdown()); }
    restart() { return this.#enqueue(async () => { await this.#shutdown(); await this.#start(); }); }
    async #start() {
        if (this.#status === 'running') { return; }
        // A failed close has already stopped write admission. Finish closing
        // before initialization, or start would report running with a closed queue.
        if (this.#closePending) { await this.#shutdown(); }
        this.#status = 'initializing';
        try {
            await this.#initialize();
            this.#status = 'running';
            this.#publish(EVENTS.STARTED, createEvent(EVENTS.STARTED));
        } catch (error) { this.#status = 'error'; throw error; }
    }
    async #shutdown() {
        if (this.#status === 'shutdown') { return; }
        this.#status = 'shutting down';
        this.#closePending = true;
        try {
            await this.#close();
            this.#closePending = false;
            this.#status = 'shutdown';
            this.#publish(EVENTS.SHUTDOWN, createEvent(EVENTS.SHUTDOWN));
        } catch (error) { this.#status = 'error'; throw error; }
    }
}

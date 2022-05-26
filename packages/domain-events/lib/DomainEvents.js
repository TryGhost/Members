const EventEmitter = require('events').EventEmitter;

/**
 * @template T
 * @typedef {import('./').ConstructorOf<T>} ConstructorOf<T>
 */

/**
 * @template Data
 * @typedef {object} IEvent
 * @prop {Date} timestamp
 * @prop {Data} data
 */

class DomainEvents {
    /**
     * @private
     * @type EventEmitter
     */
    ee = null;

    constructor() {
        this.ee = new EventEmitter;
    }

    /**
     * @template Data
     * @template {IEvent<Data>} EventClass
     * @param {ConstructorOf<EventClass>} Event
     * @param {(event: EventClass) => void} handler
     *
     * @returns {void}
     */
    subscribe(Event, handler) {
        this.ee.on(Event.name, handler);
    }

    /**
     * @template Data
     * @param {IEvent<Data>} event
     * @returns {void}
     */
    dispatch(event) {
        this.ee.emit(event.constructor.name, event);
    }
}

module.exports = DomainEvents;

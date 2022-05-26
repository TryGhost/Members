const should = require('should');
const DomainEvents = require('../');

class TestEvent {
    /**
     * @param {string} message
     */
    constructor(message) {
        this.timestamp = new Date();
        this.data = {
            message
        };
    }
}

describe('DomainEvents', function () {
    it('Will call multiple subscribers with the event when it is dispatched', function (done) {
        const event = new TestEvent('Hello, world!');

        let called = 0;

        /**
         * @param {TestEvent} receivedEvent
         */
        function handler1(receivedEvent) {
            should.equal(receivedEvent, event);
            called += 1;
            if (called === 2) {
                done();
            }
        }

        /**
         * @param {TestEvent} receivedEvent
         */
        function handler2(receivedEvent) {
            should.equal(receivedEvent, event);
            called += 1;
            if (called === 2) {
                done();
            }
        }

        const events = new DomainEvents();

        events.subscribe(TestEvent, handler1);
        events.subscribe(TestEvent, handler2);

        events.dispatch(event);
    });
});

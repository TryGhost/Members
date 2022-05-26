const {
    MemberEntryViewEvent,
    MemberUnsubscribeEvent,
    MemberSignupEvent,
    MemberPaidConverstionEvent,
    MemberPaidCancellationEvent
} = require('@tryghost/member-events');

const AnalyticEvent = require('./AnalyticEvent');

class EventHandler {
    /**
     * @param {import('./AnalyticEventRepository')} repository
     * @param {import('@tryghost/domain-events')} domainEvents
     */
    constructor(repository, domainEvents) {
        /** @private */
        this.repository = repository;
        /** @private */
        this.domainEvents = domainEvents;
    }

    /**
     * Listens for member events and handles creating analytic events and storing them.
     */
    setupSubscribers() {
        this.domainEvents.subscribe(MemberEntryViewEvent, async (ev) => {
            const event = AnalyticEvent.create({
                name: 'entry_view',
                memberId: ev.data.memberId,
                memberStatus: ev.data.memberStatus,
                entryId: ev.data.entryId,
                sourceUrl: ev.data.entryUrl,
                timestamp: ev.timestamp
            });

            await this.repository.save(event);
        });

        this.domainEvents.subscribe(MemberUnsubscribeEvent, async (ev) => {
            const event = AnalyticEvent.create({
                name: 'unsubscribe',
                memberId: ev.data.memberId,
                memberStatus: ev.data.memberStatus,
                entryId: ev.data.entryId,
                sourceUrl: ev.data.sourceUrl,
                timestamp: ev.timestamp
            });

            await this.repository.save(event);
        });

        this.domainEvents.subscribe(MemberSignupEvent, async (ev) => {
            const event = AnalyticEvent.create({
                name: 'signup',
                memberId: ev.data.memberId,
                memberStatus: 'free',
                entryId: ev.data.entryId,
                sourceUrl: ev.data.sourceUrl,
                timestamp: ev.timestamp
            });

            await this.repository.save(event);
        });

        this.domainEvents.subscribe(MemberPaidCancellationEvent, async (ev) => {
            const event = AnalyticEvent.create({
                name: 'paid_cancellation',
                memberId: ev.data.memberId,
                memberStatus: ev.data.memberStatus,
                entryId: ev.data.entryId,
                sourceUrl: ev.data.sourceUrl,
                metadata: ev.data.subscriptionId,
                timestamp: ev.timestamp
            });

            await this.repository.save(event);
        });

        this.domainEvents.subscribe(MemberPaidConverstionEvent, async (ev) => {
            const event = AnalyticEvent.create({
                name: 'paid_conversion',
                memberId: ev.data.memberId,
                memberStatus: ev.data.memberStatus,
                entryId: ev.data.entryId,
                sourceUrl: ev.data.sourceUrl,
                metadata: ev.data.subscriptionId,
                timestamp: ev.timestamp
            });

            await this.repository.save(event);
        });
    }
}

module.exports = EventHandler;

const DomainEvents = require('@tryghost/domain-events');
const {MemberEntryViewEvent} = require('@tryghost/member-events');

/**
 * @template Data
 * @typedef {object} IEvent
 * @prop {Data} data
 */

class EventsRepository {
    static create(data) {
        if (data.type === 'entry_view') {
            const {entryId, entryUrl, memberId, memberStatus, createdAt} = data;
            const entryEvent = new MemberEntryViewEvent({
                entryId,
                entryUrl,
                memberId,
                memberStatus
            }, createdAt);
            DomainEvents.dispatch(entryEvent);
        }
    }
}

module.exports = EventsRepository;

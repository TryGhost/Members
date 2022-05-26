const AnalyticEventRepository = require('./lib/AnalyticEventRepository');
const EventHandler = require('./lib/EventHandler');

class MemberAnalyticsService {
    /**
     * @param {AnalyticEventRepository} analyticEventRepository
     * @param {import('@tryghost/domain-events')} domainEvents
     */
    constructor(analyticEventRepository) {
        this.eventHandler = new EventHandler(analyticEventRepository, domainEvents);
    }

    static create(AnalyticEventModel) {
        const analyticEventRepository = new AnalyticEventRepository(AnalyticEventModel);

        return new MemberAnalyticsService(analyticEventRepository);
    }
}

module.exports = MemberAnalyticsService;

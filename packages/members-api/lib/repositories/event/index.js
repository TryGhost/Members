module.exports = class EventRepository {
    constructor({
        MemberSubscribeEvent,
        logger
    }) {
        this._MemberSubscribeEvent = MemberSubscribeEvent;
        this._logging = logger;
    }

    async getSubscriptions() {
        const results = await this._MemberSubscribeEvent.findAll({
            aggregateSubscriptionDeltas: true
        });

        const resultsJSON = results.toJSON();

        const cumulativeResults = resultsJSON.reduce((cumulativeResults, result, index) => {
            if (index === 0) {
                return [{
                    date: result.date,
                    subscribed: result.subscribed_delta
                }];
            }
            return cumulativeResults.concat([{
                date: result.date,
                subscribed: result.subscribed_delta + cumulativeResults[index - 1].subscribed
            }]);
        }, []);

        return cumulativeResults;
    }
};

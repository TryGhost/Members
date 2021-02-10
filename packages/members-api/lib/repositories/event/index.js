const _ = require('lodash');

function isToday(someDate) {
    const today = new Date();
    return someDate.getDate() === today.getDate() &&
        someDate.getMonth() === today.getMonth() &&
        someDate.getFullYear() === today.getFullYear();
}
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
        const totalSubscriptions = (_.last(cumulativeResults) && _.last(cumulativeResults).subscribed) || 0;

        let newToday = 0;
        if (resultsJSON.length > 0) {
            const lastEntry = _.last(resultsJSON);
            newToday = isToday(new Date(lastEntry.date)) ? lastEntry.subscribed_delta : 0;
        }

        return {
            total: totalSubscriptions,
            total_in_range: totalSubscriptions,
            total_on_date: cumulativeResults,
            new_today: newToday
        };
    }
};

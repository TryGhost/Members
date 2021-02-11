module.exports = class EventRepository {
    constructor({
        MemberSubscribeEvent,
        MemberPaidSubscriptionEvent,
        logger
    }) {
        this._MemberSubscribeEvent = MemberSubscribeEvent;
        this._MemberPaidSubscriptionEvent = MemberPaidSubscriptionEvent;
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

    async getMRR() {
        const results = await this._MemberPaidSubscriptionEvent.findAll({
            aggregateMRRDeltas: true
        });

        const resultsJSON = results.toJSON();

        console.log(resultsJSON);

        const cumulativeResults = resultsJSON.reduce((cumulativeResults, result) => {
            if (!cumulativeResults[result.currency]) {
                return {
                    ...cumulativeResults,
                    [result.currency]: [{
                        date: result.date,
                        mrr: result.mrr_delta,
                        currency: result.currency
                    }]
                };
            }
            return {
                ...cumulativeResults,
                [result.currency]: cumulativeResults[result.currency].concat([{
                    date: result.date,
                    mrr: result.mrr_delta + cumulativeResults[result.currency].slice(-1)[0],
                    currency: result.currency
                }])
            };
        }, {});

        console.log(cumulativeResults);

        return cumulativeResults;
    }
};

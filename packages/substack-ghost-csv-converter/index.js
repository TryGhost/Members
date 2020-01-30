const {normalizeMembersCSV} = require('./lib');

const convertCSV = async (originFilePath, destinationFilePath) => {
    await normalizeMembersCSV({
        origin: originFilePath,
        destination: destinationFilePath,
        columnsToMap: [{
            from: 'email_disabled',
            to: 'subscribed',
            negate: true
        }, {
            from: 'stripe_connected_customer_id',
            to: 'stripe_customer_id'
        }],
        columnsToExtract: [{
            name: 'email',
            lookup: /email/i
        }, {
            name: 'name',
            lookup: /name/i
        }, {
            name: 'note',
            lookup: /note/i
        }, {
            name: 'subscribed',
            lookup: /subscribed/i
        }, {
            name: 'stripe_customer_id',
            lookup: /stripe_customer_id/i
        }, {
            name: 'complimentary_plan',
            lookup: /complimentary_plan/i
        }]
    });
};

module.exports = convertCSV;

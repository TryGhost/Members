const path = require('path');
const {normalizeMembersCSV} = require('../../lib');
// Switch these lines once there are useful utils
// const testUtils = require('./utils');
require('../utils');

describe('Converts Substack CSV to Ghost CSV formats', function () {
    it('Reads CSV and converts it to normalized JSON', async function () {
        const result = await normalizeMembersCSV.normalizeCSVFileToJSON({
            path: path.resolve('./test/fixtures/substack-csv-format.csv'),
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

        result.length.should.equal(2);
        Object.keys(result[0]).should.deepEqual(['email', 'subscribed', 'stripe_customer_id']);
    });
});

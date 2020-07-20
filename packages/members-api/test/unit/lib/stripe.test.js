const http = require('http');
const util = require('util');
const should = require('should');
const Stripe = require('stripe');
const stripeAPI = require('../../../lib/stripe/api');

const config = {
    publishableKey: 'pk_test_00000000000000000000',
    secretKey: 'pk_test_00000000000000000000',
    apiVersion: '2019-09-09',
    webhookSecret: 'whsec_00000000000000000'
};

async function setupStripeServer(stripe) {
    const server = http.createServer();
    const listen = util.promisify(server.listen.bind(server));

    await listen(0, '127.0.0.1');

    const {address: host, port} = server.address();
    stripe.setProtocol('http');
    stripe.setHost(host);
    stripe.setPort(port);

    return server;
}

describe('Plans API', function () {
    it('Uses an idempotency key when creating plans', async function () {
        const stripe = new Stripe(config.secretKey, config.apiVersion);

        const server = await setupStripeServer(stripe);

        server.on('request', function (req, res) {
            res.writeHead(200);
            res.end('{}');

            should.exist(req.headers['idempotency-key'], 'Request should have had an Idempotency-Key header');
            should.equal(req.headers['idempotency-key'], 'PLAN_ID', 'Should have used the plan id as the Idempotency-Key header value');

            req.connection.destroy();
        });

        try {
            await stripeAPI.plans.create(stripe, 'PLAN_ID', {
                name: 'plan',
                amount: 100,
                currency: 'usd',
                interval: 'year'
            }, {
                product: {
                    id: 'PRODUCT_ID'
                }
            });
        } finally {
            server.close();
        }
    });
});

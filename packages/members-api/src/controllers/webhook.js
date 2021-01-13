const {Router} = require('express');
const body = require('body-parser');
const common = require('../../lib/common');

module.exports = class WebhookController {
    /**
     * @param {object} deps
     * @param {any} deps.WebhookService
     * @param {any} deps.Stripe
     */
    constructor({
        WebhookService,
        Stripe
    }) {
        this._WebhookService = WebhookService;
        this._Stripe = Stripe;
    }

    async ensureStripe(_req, res, next) {
        if (!this._Stripe) {
            res.writeHead(400);
            return res.end('Stripe not configured');
        }
        try {
            await this._Stripe.ready();
            next();
        } catch (err) {
            res.writeHead(500);
            return res.end('There was an error configuring stripe');
        }
    }

    handleStripeWebhook() {
        return Router().use(this.ensureStripe, body.raw({type: 'application/json'}), async (req, res) => {
            let event;
            try {
                event = await this._Stripe.parseWebhook(req.body, req.headers['stripe-signature']);
            } catch (err) {
                common.logging.error(err);
                res.writeHead(401);
                return res.end();
            }
            common.logging.info(`Handling webhook ${event.type}`);
            try {
                if (event.type === 'customer.subscription.deleted') {
                    await this._WebhookService.handleCustomerSubscriptionDeletedWebhook(event.data.object);
                }

                if (event.type === 'customer.subscription.updated') {
                    await this._WebhookService.handleCustomerSubscriptionUpdatedWebhook(event.data.object);
                }

                if (event.type === 'customer.subscription.created') {
                    await this._WebhookService.handleCustomerSubscriptionCreatedWebhook(event.data.object);
                }

                if (event.type === 'invoice.payment_succeeded') {
                    await this._WebhookService.handleInvoicePaymentSucceededWebhook(event.data.object);
                }

                if (event.type === 'invoice.payment_failed') {
                    await this._WebhookService.handleInvoicePaymentFailedWebhook(event.data.object);
                }

                if (event.type === 'checkout.session.completed') {
                    await this._WebhookService.handleCheckoutSessionCompletedWebhook(event.data.object);
                }

                res.writeHead(200);
                res.end();
            } catch (err) {
                common.logging.error(`Error handling webhook ${event.type}`, err);
                res.writeHead(400);
                res.end();
            }
        });
    }
};
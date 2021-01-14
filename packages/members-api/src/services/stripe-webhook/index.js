module.exports = class StripeWebhookService {
    /**
     * @param {object} deps
     * @param {any} deps.StripeWebhook
     * @param {import('../stripe-api')} deps.stripeAPIService
     */
    constructor({
        StripeWebhook,
        stripeAPIService
    }) {
        this._StripeWebhook = StripeWebhook;
        this._stripeAPIService = stripeAPIService;
    }

    async configure(config) {
        if (config.webhookSecret) {
            this._webhookSecret = config.webhookSecret;
            return;
        }

        /** @type {import('stripe').events.EventType[]} */
        const events = [
            'checkout.session.completed',
            'customer.subscription.deleted',
            'customer.subscription.updated',
            'customer.subscription.created',
            'invoice.payment_succeeded',
            'invoice.payment_failed'
        ];

        const setupWebhook = async (id, secret, opts = {}) => {
            if (!id || !secret || opts.forceCreate) {
                if (id && !opts.skipDelete) {
                    try {
                        await this._stripeAPIService.deleteWebhookEndpoint(id);
                    } catch (err) {
                        // Continue
                    }
                }
                const webhook = await this._stripeAPIService.createWebhookEndpoint(
                    config.webhookHandlerUrl,
                    events
                );
                return {
                    id: webhook.id,
                    secret: webhook.secret
                };
            } else {
                try {
                    await this._stripeAPIService.updateWebhookEndpoint(
                        id,
                        config.webhookHandlerUrl,
                        events
                    );

                    return {
                        id,
                        secret
                    };
                } catch (err) {
                    if (err.code === 'resource_missing') {
                        return setupWebhook(id, secret, {skipDelete: true, forceCreate: true});
                    }
                    return setupWebhook(id, secret, {skipDelete: false, forceCreate: true});
                }
            }
        };

        const webhook = await setupWebhook(config.webhook.id, config.webhook.secret);
        await this._StripeWebhook.upsert({
            webhook_id: webhook.id,
            secret: webhook.secret
        }, {webhook_id: webhook.id});
        this._webhookSecret = webhook.secret;
    }
};

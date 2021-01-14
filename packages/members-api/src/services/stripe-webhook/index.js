module.exports = class StripeWebhookService {
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

        const webhookConfig = {
            url: config.webhookHandlerUrl,
            enabled_events: [
                'checkout.session.completed',
                'customer.subscription.deleted',
                'customer.subscription.updated',
                'customer.subscription.created',
                'invoice.payment_succeeded',
                'invoice.payment_failed'
            ]
        };

        const setupWebhook = async (id, secret, opts = {}) => {
            if (!id || !secret || opts.forceCreate) {
                if (id && !opts.skipDelete) {
                    try {
                        this.logging.info(`Deleting Stripe webhook ${id}`);
                        await del(this._stripe, 'webhookEndpoints', id);
                    } catch (err) {
                        this.logging.error(`Unable to delete Stripe webhook with id: ${id}`);
                        this.logging.error(err);
                    }
                }
                try {
                    this.logging.info(`Creating Stripe webhook with url: ${webhookConfig.url}, version: ${STRIPE_API_VERSION}, events: ${webhookConfig.enabled_events.join(', ')}`);
                    const webhook = await create(this._stripe, 'webhookEndpoints', Object.assign({}, webhookConfig, {
                        api_version: STRIPE_API_VERSION
                    }));
                    return {
                        id: webhook.id,
                        secret: webhook.secret
                    };
                } catch (err) {
                    this.logging.error('Failed to create Stripe webhook. For local development please see https://ghost.org/docs/members/webhooks/#stripe-webhooks');
                    this.logging.error(err);
                    throw err;
                }
            } else {
                try {
                    this.logging.info(`Updating Stripe webhook ${id} with url: ${webhookConfig.url}, events: ${webhookConfig.enabled_events.join(', ')}`);
                    const updatedWebhook = await update(this._stripe, 'webhookEndpoints', id, webhookConfig);

                    if (updatedWebhook.api_version !== STRIPE_API_VERSION) {
                        throw new Error(`Webhook ${id} has api_version ${updatedWebhook.api_version}, expected ${STRIPE_API_VERSION}`);
                    }

                    return {
                        id,
                        secret
                    };
                } catch (err) {
                    this.logging.error(`Unable to update Stripe webhook ${id}`);
                    this.logging.error(err);
                    if (err.code === 'resource_missing') {
                        return setupWebhook(id, secret, {skipDelete: true, forceCreate: true});
                    }
                    return setupWebhook(id, secret, {skipDelete: false, forceCreate: true});
                }
            }
        };

        try {
            const webhook = await setupWebhook(config.webhook.id, config.webhook.secret);
            await this.storage.set({
                webhook: {
                    webhook_id: webhook.id,
                    secret: webhook.secret
                }
            });
            this._webhookSecret = webhook.secret;
        } catch (err) {
            return this._rejectReady(err);
        }
    }
};

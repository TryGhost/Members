const _ = require('lodash');
const errors = require('@tryghost/errors');
const DomainEvents = require('@tryghost/domain-events');
const {SubscriptionCreatedEvent} = require('@tryghost/member-events');

module.exports = class StripeWebhookService {
    /**
     * @param {object} deps
     * @param {any} deps.StripeWebhook
     * @param {import('../stripe-api')} deps.stripeAPIService
     * @param {import('../../repositories/member')} deps.memberRepository
     * @param {import('../../repositories/product')} deps.productRepository
     * @param {import('../../repositories/event')} deps.eventRepository
     * @param {(email: string) => Promise<void>} deps.sendSignupEmail
     */
    constructor({
        StripeWebhook,
        stripeAPIService,
        productRepository,
        memberRepository,
        eventRepository,
        sendSignupEmail
    }) {
        this._StripeWebhook = StripeWebhook;
        this._stripeAPIService = stripeAPIService;
        this._productRepository = productRepository;
        this._memberRepository = memberRepository;
        this._eventRepository = eventRepository;
        /** @private */
        this.sendSignupEmail = sendSignupEmail;
        this.handlers = {};
        this.registerHandler('customer.subscription.deleted', this.subscriptionEvent);
        this.registerHandler('customer.subscription.updated', this.subscriptionEvent);
        this.registerHandler('customer.subscription.created', this.subscriptionEvent);
        this.registerHandler('invoice.payment_succeeded', this.invoiceEvent);
        this.registerHandler('checkout.session.completed', this.checkoutSessionEvent);
    }

    registerHandler(event, handler) {
        this.handlers[event] = handler.name;
    }

    async configure(config) {
        if (config.webhookSecret) {
            this._webhookSecret = config.webhookSecret;
            return;
        }

        /** @type {import('stripe').Stripe.WebhookEndpointCreateParams.EnabledEvent[]} */
        const events = [
            'checkout.session.completed',
            'customer.subscription.deleted',
            'customer.subscription.updated',
            'customer.subscription.created',
            'invoice.payment_succeeded'
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

    /**
     * @param {string} id - WebhookEndpoint Stripe ID
     *
     * @returns {Promise<boolean>}
     */
    async removeWebhook(id) {
        try {
            await this._stripeAPIService.deleteWebhookEndpoint(id);
            return true;
        } catch (err) {
            return false;
        }
    }

    /**
     * @param {string} body
     * @param {string} signature
     * @returns {import('stripe').Stripe.Event}
     */
    parseWebhook(body, signature) {
        return this._stripeAPIService.parseWebhook(body, signature, this._webhookSecret);
    }

    /**
     * @param {import('stripe').Stripe.Event} event
     *
     * @returns {Promise<void>}
     */
    async handleWebhook(event) {
        if (!this.handlers[event.type]) {
            return;
        }

        await this[this.handlers[event.type]](event.data.object);
    }

    async subscriptionEvent(subscription) {
        const member = await this._memberRepository.get({
            customer_id: subscription.customer
        });
        const subscriptionPriceData = _.get(subscription, 'items.data');
        if (!subscriptionPriceData || subscriptionPriceData.length !== 1) {
            throw new errors.BadRequestError({
                message: 'Subscription should have exactly 1 price item'
            });
        }
        if (member) {
            await this._memberRepository.linkSubscription({
                id: member.id,
                subscription
            });
        }
    }

    /**
     * @param {import('stripe').Stripe.Invoice} invoice
     *
     * @returns {Promise<void>}
     */
    async invoiceEvent(invoice) {
        if (!invoice.subscription) {
            return;
        }
        const subscription = await this._stripeAPIService.getSubscription(invoice.subscription, {
            expand: ['default_payment_method']
        });

        const member = await this._memberRepository.get({
            customer_id: subscription.customer
        });

        if (member) {
            if (invoice.paid && invoice.amount_paid !== 0) {
                await this._eventRepository.registerPayment({
                    member_id: member.id,
                    currency: invoice.currency,
                    amount: invoice.amount_paid
                });
            }
        } else {
            // Subscription has more than one plan - meaning it is not one created by us - ignore.
            if (!subscription.plan) {
                return;
            }
            // Subscription is for a different product - ignore.
            const product = await this._productRepository.get({
                stripe_product_id: subscription.plan.product
            });
            if (!product) {
                return;
            }

            // Could not find the member, which we need in order to insert an payment event.
            throw new errors.NotFoundError({
                message: `No member found for customer ${subscription.customer}`
            });
        }
    }

    async checkoutSessionEvent(session) {
        if (session.mode === 'setup') {
            const setupIntent = await this._stripeAPIService.getSetupIntent(session.setup_intent);
            const member = await this._memberRepository.get({
                customer_id: setupIntent.metadata.customer_id
            });

            await this._stripeAPIService.attachPaymentMethodToCustomer(
                setupIntent.metadata.customer_id,
                setupIntent.payment_method
            );

            if (setupIntent.metadata.subscription_id) {
                const updatedSubscription = await this._stripeAPIService.updateSubscriptionDefaultPaymentMethod(
                    setupIntent.metadata.subscription_id,
                    setupIntent.payment_method
                );
                await this._memberRepository.linkSubscription({
                    id: member.id,
                    subscription: updatedSubscription
                });
                return;
            }

            const subscriptions = await member.related('stripeSubscriptions').fetch();

            const activeSubscriptions = subscriptions.models.filter((subscription) => {
                return ['active', 'trialing', 'unpaid', 'past_due'].includes(subscription.get('status'));
            });

            for (const subscription of activeSubscriptions) {
                if (subscription.get('customer_id') === setupIntent.metadata.customer_id) {
                    const updatedSubscription = await this._stripeAPIService.updateSubscriptionDefaultPaymentMethod(
                        subscription.get('subscription_id'),
                        setupIntent.payment_method
                    );
                    await this._memberRepository.linkSubscription({
                        id: member.id,
                        subscription: updatedSubscription
                    });
                }
            }
        }

        if (session.mode === 'subscription') {
            const customer = await this._stripeAPIService.getCustomer(session.customer, {
                expand: ['subscriptions.data.default_payment_method']
            });

            let member = await this._memberRepository.get({
                email: customer.email
            });

            const checkoutType = _.get(session, 'metadata.checkoutType');

            if (!member) {
                const metadataName = _.get(session, 'metadata.name');
                const payerName = _.get(customer, 'subscriptions.data[0].default_payment_method.billing_details.name');
                const name = metadataName || payerName || null;
                member = await this._memberRepository.create({email: customer.email, name});
            } else {
                const payerName = _.get(customer, 'subscriptions.data[0].default_payment_method.billing_details.name');

                if (payerName && !member.get('name')) {
                    await this._memberRepository.update({name: payerName}, {id: member.get('id')});
                }
            }

            await this._memberRepository.upsertCustomer({
                customer_id: customer.id,
                member_id: member.id,
                name: customer.name,
                email: customer.email
            });

            for (const subscription of customer.subscriptions.data) {
                await this._memberRepository.linkSubscription({
                    id: member.id,
                    subscription
                });
            }

            const subscription = await this._memberRepository.getSubscriptionByStripeID(session.subscription);

            const event = SubscriptionCreatedEvent.create({
                memberId: member.id,
                subscriptionId: subscription.id,
                offerId: session.metadata.offer || null
            });

            DomainEvents.dispatch(event);

            if (checkoutType !== 'upgrade') {
                this.sendSignupEmail(customer.email);
            }
        }
    }
};

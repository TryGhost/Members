const _ = require('lodash');
const common = require('../../lib/common');

module.exports = class WebhookService {
    /**
     * @param {object} deps
     * @param {any} deps.Stripe
     * @param {any} deps.MemberRepository
     * @param {any} deps.MagicLinkService
     */
    constructor({
        Stripe,
        MemberRepository,
        MagicLinkService
    }) {
        this._Stripe = Stripe;
        this._MemberRepository = MemberRepository;
        this._MagicLinkService = MagicLinkService;
    }

    async handleCustomerSubscriptionDeletedWebhook(subscription) {
        await this._Stripe.updateSubscription(subscription);
    }

    async handleCustomerSubscriptionUpdatedWebhook(subscription) {
        await this._Stripe.updateSubscription(subscription);
    }

    async handleCustomerSubscriptionCreatedWebhook(subscription) {
        await this._Stripe.updateSubscription(subscription);
    }

    async handleInvoicePaymentSucceededWebhook(invoice) {
        const subscription = await this._Stripe.retrieve('subscriptions', invoice.subscription, {
            expand: ['default_payment_method']
        });
        await this._Stripe.updateSubscription(subscription);
    }

    async handleInvoicePaymentFailedWebhook(invoice) {
        const subscription = await this._Stripe.retrieve('subscriptions', invoice.subscription, {
            expand: ['default_payment_method']
        });
        await this._Stripe.updateSubscription(subscription);
    }

    async handleCheckoutSessionCompletedWebhook(eventObj) {
        if (eventObj.mode === 'setup') {
            common.logging.info('Handling "setup" mode Checkout Session');
            const setupIntent = await this._Stripe.getSetupIntent(eventObj.setup_intent);
            const customer = await this._Stripe.getCustomer(setupIntent.metadata.customer_id);
            const member = await this._MemberRepository.get({email: customer.email});

            await this._Stripe.handleCheckoutSetupSessionCompletedWebhook(setupIntent, member);
        } else if (eventObj.mode === 'subscription') {
            common.logging.info('Handling "subscription" mode Checkout Session');
            const customer = await this._Stripe.getCustomer(eventObj.customer, {
                expand: ['subscriptions.data.default_payment_method']
            });
            let member = await this._MemberRepository.get({email: customer.email});
            const checkoutType = _.get(eventObj, 'metadata.checkoutType');
            const requestSrc = _.get(eventObj, 'metadata.requestSrc') || '';
            if (!member) {
                const metadataName = _.get(eventObj, 'metadata.name');
                const payerName = _.get(customer, 'subscriptions.data[0].default_payment_method.billing_details.name');
                const name = metadataName || payerName || null;
                member = await this._MemberRepository.create({email: customer.email, name});
            } else {
                const payerName = _.get(customer, 'subscriptions.data[0].default_payment_method.billing_details.name');

                if (payerName && !member.get('name')) {
                    await this._MemberRepository.update({name: payerName}, {id: member.get('id')});
                }
            }

            await this._Stripe.handleCheckoutSessionCompletedWebhook(member, customer);
            if (checkoutType !== 'upgrade') {
                const emailType = 'signup';
                await this._MagicLinkService.sendEmailWithMagicLink({email: customer.email, requestedType: emailType, requestSrc, options: {forceEmailType: true}, tokenData: {}});
            }
        } else if (eventObj.mode === 'payment') {
            common.logging.info('Ignoring "payment" mode Checkout Session');
        }
    }
};
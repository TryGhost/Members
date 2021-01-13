module.exports = class MemberRepository {
    /**
     * @param {object} deps
     * @param {any} deps.Member
     * @param {any} deps.StripeCustomer
     * @param {any} deps.StripeCustomerSubscription
     * @param {import('../../services/stripe')} deps.StripeAPIService
     */
    constructor({
        Member,
        StripeCustomer,
        StripeCustomerSubscription,
        StripeAPIService
    }) {
        this._Member = Member;
        this._StripeCustomer = StripeCustomer;
        this._StripeCustomerSubscription = StripeCustomerSubscription;
        this._StripeAPIService = StripeAPIService;
    }

    async get(data, options) {
        return this._Member.findOne(data, options);
    }

    async create(data, options) {
        const {labels} = data;

        if (labels) {
            labels.forEach((label, index) => {
                if (typeof label === 'string') {
                    labels[index] = {name: label};
                }
            });
        }

        // @NOTE: Use _.pick
        return this._Member.add({
            labels,
            email: data.email,
            name: data.name,
            note: data.note,
            subscribed: data.subscribed,
            geolocation: data.geolocation,
            created_at: data.created_at
        }, options);
    }

    async update(data, options) {
        const member = await this._Member.edit({
            email: data.email,
            name: data.name,
            note: data.note,
            subscribed: data.subscribed,
            labels: data.labels,
            geolocation: data.geolocation
        }, options);

        if (member._changed.email) {
            await member.related('stripeCustomers').fetch();
            const customers = member.related('stripeCustomers');
            for (const customer of customers.models) {
                await this._StripeAPIService.updateCustomerEmail(
                    customer.get('customer_id'),
                    member.get('email')
                );
            }
        }
    }

    async list(options) {
        return this._Member.findPage(options);
    }

    async destroy(data, options) {
        const member = await this._Member.findOne(data, options);

        if (!member) {
            // throw error?
            return;
        }

        if (options.cancelStripeSubscriptions) {
            await member.related('stripeSubscriptions');
            const subscriptions = member.related('stripeSubscriptions');
            for (const subscription of subscriptions.models) {
                if (subscription.get('status') !== 'canceled') {
                    const updatedSubscription = await this._StripeAPIService.cancelSubscription(
                        subscription.get('subscription_id')
                    );
                    await this._StripeCustomerSubscription.update({
                        status: updatedSubscription.status
                    });
                }
            }
        }

        return this._Member.destroy({
            id: data.id
        }, options);
    }

    async linkStripeCustomer(data) {
        const customer = await this._StripeAPIService.getCustomer(data.customer_id);

        if (!customer) {
            return;
        }

        // Add instead of upsert ensures that we do not link existing customer
        await this._StripeCustomer.add({
            customer_id: data.customer_id,
            member_id: data.member_id,
            name: customer.name,
            email: customer.email
        });

        for (const subscription of customer.subscriptions.data) {
            let paymentMethodId;
            if (typeof subscription.default_payment_method === 'string') {
                paymentMethodId = subscription.default_payment_method;
            } else {
                paymentMethodId = subscription.default_payment_method.id;
            }
            const paymentMethod = await this._StripeAPIService.getCardPaymentMethod(paymentMethodId);
            await this._StripeCustomerSubscription.upsert({
                customer_id: data.customer_id,
                subscription_id: subscription.id,
                status: subscription.status,
                cancel_at_period_end: subscription.cancel_at_period_end,
                cancellation_reason: subscription.metadata && subscription.metadata.cancellation_reason || null,
                current_period_end: new Date(subscription.current_period_end * 1000),
                start_date: new Date(subscription.start_date * 1000),
                default_payment_card_last4: paymentMethod && paymentMethod.card && paymentMethod.card.last4 || null,

                plan_id: subscription.plan.id,
                // NOTE: Defaulting to interval as migration to nullable field
                // turned out to be much bigger problem.
                // Ideally, would need nickname field to be nullable on the DB level
                // condition can be simplified once this is done
                plan_nickname: subscription.plan.nickname || subscription.plan.interval,
                plan_interval: subscription.plan.interval,
                plan_amount: subscription.plan.amount,
                plan_currency: subscription.plan.currency
            });
        }
    }

    async updateSubscription(data) {
        const member = await this._Member.findOne({
            id: data.id
        });

        const subscription = await member.related('stripeSubscriptions').where({
            subscription_id: data.subscription.subscription_id
        }).fetchOne();

        if (!subscription) {
            throw new Error('Subscription not found');
        }

        if (data.subscription.cancel_at_period_end === undefined) {
            throw new Error('Incorrect usage');
        }

        if (data.subscription.cancel_at_period_end) {
            await this._StripeAPIService.cancelSubscriptionAtPeriodEnd(data.subscription.subscription_id);
        } else {
            await this._StripeAPIService.continueSubscriptionAtPeriodEnd(data.subscription.subscription_id);
        }

        await this._StripeCustomerSubscription.update({
            subscription_id: data.subscription.subscription_id,
            cancel_at_period_end: data.subscription.cancel_at_period_end
        });
    }

    async setComplimentarySubscription() {}
    async cancelComplimentarySubscription() {}
};

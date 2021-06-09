const _ = require('lodash');

module.exports = class MemberRepository {
    /**
     * @param {object} deps
     * @param {any} deps.Member
     * @param {any} deps.MemberSubscribeEvent
     * @param {any} deps.MemberEmailChangeEvent
     * @param {any} deps.MemberPaidSubscriptionEvent
     * @param {any} deps.MemberStatusEvent
     * @param {any} deps.StripeCustomer
     * @param {any} deps.StripeCustomerSubscription
     * @param {any} deps.productRepository
     * @param {import('../../services/stripe-api')} deps.stripeAPIService
     * @param {any} deps.logger
     */
    constructor({
        Member,
        MemberSubscribeEvent,
        MemberEmailChangeEvent,
        MemberPaidSubscriptionEvent,
        MemberStatusEvent,
        StripeCustomer,
        StripeCustomerSubscription,
        stripeAPIService,
        productRepository,
        logger
    }) {
        this._Member = Member;
        this._MemberSubscribeEvent = MemberSubscribeEvent;
        this._MemberEmailChangeEvent = MemberEmailChangeEvent;
        this._MemberPaidSubscriptionEvent = MemberPaidSubscriptionEvent;
        this._MemberStatusEvent = MemberStatusEvent;
        this._StripeCustomer = StripeCustomer;
        this._StripeCustomerSubscription = StripeCustomerSubscription;
        this._stripeAPIService = stripeAPIService;
        this._productRepository = productRepository;
        this._logging = logger;
    }

    isActiveSubscriptionStatus(status) {
        return ['active', 'trialing', 'unpaid', 'past_due'].includes(status);
    }

    async get(data, options) {
        if (data.customer_id) {
            const customer = await this._StripeCustomer.findOne({
                customer_id: data.customer_id
            }, {
                withRelated: ['member']
            });
            if (customer) {
                return customer.related('member');
            }
            return null;
        }
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

        const allowedProperties = [
            'email',
            'name',
            'note',
            'subscribed',
            'geolocation'
        ];

        if (!this._stripeAPIService.configured) {
            allowedProperties.push('products')
        }

        const cleanData = _.pick(data, allowedProperties);

        const member = await this._Member.add({
            ...cleanData,
            labels
        }, options);

        const context = options && options.context || {};
        let source;

        if (context.internal) {
            source = 'system';
        } else if (context.user) {
            source = 'admin';
        } else {
            source = 'member';
        }

        await this._MemberStatusEvent.add({
            member_id: member.id,
            from_status: null,
            to_status: member.get('status')
        }, options);

        if (member.get('subscribed')) {
            await this._MemberSubscribeEvent.add({
                member_id: member.id,
                subscribed: true,
                source
            }, options);
        }

        return member;
    }

    async update(data, options) {
        const allowedProperties = [
            'email',
            'name',
            'note',
            'subscribed',
            'labels',
            'geolocation'
        ];

        if (!this._stripeAPIService.configured) {
            allowedProperties.push('products')
        }

        const cleanData = _.pick(data, allowedProperties);

        const member = await this._Member.edit(cleanData, options);

        // member._changed.subscribed has a value if the `subscribed` attribute is passed in the update call, regardless of the previous value
        if (member.attributes.subscribed !== member._previousAttributes.subscribed) {
            const context = options && options.context || {};
            let source;
            if (context.internal) {
                source = 'system';
            } else if (context.user) {
                source = 'admin';
            } else {
                source = 'member';
            }
            await this._MemberSubscribeEvent.add({
                member_id: member.id,
                subscribed: member.get('subscribed'),
                source
            }, options);
        }

        if (member.attributes.email !== member._previousAttributes.email) {
            await this._MemberEmailChangeEvent.add({
                member_id: member.id,
                from_email: member._previousAttributes.email,
                to_email: member.get('email')
            });
        }

        if (this._stripeAPIService.configured && member._changed.email) {
            await member.related('stripeCustomers').fetch();
            const customers = member.related('stripeCustomers');
            for (const customer of customers.models) {
                await this._stripeAPIService.updateCustomerEmail(
                    customer.get('customer_id'),
                    member.get('email')
                );
            }
        }

        return member;
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

        if (this._stripeAPIService.configured && options.cancelStripeSubscriptions) {
            await member.related('stripeSubscriptions').fetch();
            const subscriptions = member.related('stripeSubscriptions');
            for (const subscription of subscriptions.models) {
                if (subscription.get('status') !== 'canceled') {
                    const updatedSubscription = await this._stripeAPIService.cancelSubscription(
                        subscription.get('subscription_id')
                    );

                    await this._StripeCustomerSubscription.upsert({
                        status: updatedSubscription.status
                    }, {
                        subscription_id: updatedSubscription.id
                    });

                    await this._MemberPaidSubscriptionEvent.add({
                        member_id: member.id,
                        source: 'stripe',
                        from_plan: subscription.get('plan_id'),
                        to_plan: null,
                        currency: subscription.get('plan_currency'),
                        mrr_delta: -1 * getMRRDelta({
                            interval: subscription.get('plan_interval'),
                            amount: subscription.get('plan_amount')
                        })
                    }, options);
                }
            }
        }

        return this._Member.destroy({
            id: data.id
        }, options);
    }

    async upsertCustomer(data) {
        return await this._StripeCustomer.upsert({
            customer_id: data.customer_id,
            member_id: data.member_id,
            name: data.name,
            email: data.email
        });
    }

    async linkStripeCustomer(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot link Stripe Customer with no Stripe Connection');
        }
        const customer = await this._stripeAPIService.getCustomer(data.customer_id);

        if (!customer) {
            return;
        }

        // Add instead of upsert ensures that we do not link existing customer
        await this._StripeCustomer.add({
            customer_id: data.customer_id,
            member_id: data.member_id,
            name: customer.name,
            email: customer.email
        }, options);

        for (const subscription of customer.subscriptions.data) {
            await this.linkSubscription({
                id: data.member_id,
                subscription
            }, options);
        }
    }

    async linkSubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot link Stripe Subscription with no Stripe Connection');
        }
        const member = await this._Member.findOne({
            id: data.id
        }, options);

        const customer = await member.related('stripeCustomers').query({
            where: {
                customer_id: data.subscription.customer
            }
        }).fetchOne(options);

        if (!customer) {
            // Maybe just link the customer?
            throw new Error('Subscription is not associated with a customer for the member');
        }

        const subscription = await this._stripeAPIService.getSubscription(data.subscription.id);
        let paymentMethodId;
        if (!subscription.default_payment_method) {
            paymentMethodId = null;
        } else if (typeof subscription.default_payment_method === 'string') {
            paymentMethodId = subscription.default_payment_method;
        } else {
            paymentMethodId = subscription.default_payment_method.id;
        }
        const paymentMethod = paymentMethodId ? await this._stripeAPIService.getCardPaymentMethod(paymentMethodId) : null;

        const model = await this._StripeCustomerSubscription.findOne({
            subscription_id: subscription.id
        }, options);
        const subscriptionPriceData = _.get(subscription, 'items.data[0].price');
        let ghostProduct;
        try {
            ghostProduct = await this._productRepository.get({stripe_product_id: subscriptionPriceData.product}, options);
            // Use first Ghost product as default product in case of missing link
            if (!ghostProduct) {
                let {data: pageData} = await this._productRepository.list({limit: 1});
                ghostProduct = (pageData && pageData[0]) || null;
            }

            // Link Stripe Product & Price to Ghost Product
            if (ghostProduct) {
                await this._productRepository.update({
                    id: ghostProduct.get('id'),
                    name: ghostProduct.get('name'),
                    stripe_prices: [
                        {
                            stripe_price_id: subscriptionPriceData.id,
                            stripe_product_id: subscriptionPriceData.product,
                            active: subscriptionPriceData.active,
                            nickname: subscriptionPriceData.nickname,
                            currency: subscriptionPriceData.currency,
                            amount: subscriptionPriceData.unit_amount,
                            type: subscriptionPriceData.type,
                            interval: (subscriptionPriceData.recurring && subscriptionPriceData.recurring.interval) || null
                        }
                    ]
                }, options);
            } else {
                // Log error if no Ghost products found
                this._logging.error(`There was an error linking subscription - ${subscription.id}, no Products exist.`);
            }
        } catch (e) {
            this._logging.error(`Failed to handle prices and product for - ${subscription.id}.`);
            this._logging.error(e);
        }

        const subscriptionData = {
            customer_id: subscription.customer,
            subscription_id: subscription.id,
            status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            cancellation_reason: subscription.metadata && subscription.metadata.cancellation_reason || null,
            current_period_end: new Date(subscription.current_period_end * 1000),
            start_date: new Date(subscription.start_date * 1000),
            default_payment_card_last4: paymentMethod && paymentMethod.card && paymentMethod.card.last4 || null,
            stripe_price_id: subscriptionPriceData.id,
            plan_id: subscriptionPriceData.id,
            // NOTE: Defaulting to interval as migration to nullable field
            // turned out to be much bigger problem.
            // Ideally, would need nickname field to be nullable on the DB level
            // condition can be simplified once this is done
            plan_nickname: subscriptionPriceData.nickname || _.get(subscriptionPriceData, 'recurring.interval'),
            plan_interval: _.get(subscriptionPriceData, 'recurring.interval', ''),
            plan_amount: subscriptionPriceData.unit_amount,
            plan_currency: subscriptionPriceData.currency
        };
        if (model) {
            const updated = await this._StripeCustomerSubscription.edit(subscriptionData, {
                ...options,
                id: model.id
            });

            if (model.get('plan_id') !== updated.get('plan_id') || model.get('status') !== updated.get('status')) {
                const originalMrrDelta = getMRRDelta({interval: model.get('plan_interval'), amount: model.get('plan_amount'), status: model.get('status')});
                const updatedMrrDelta = getMRRDelta({interval: updated.get('plan_interval'), amount: updated.get('plan_amount'), status: updated.get('status')});
                const mrrDelta = updatedMrrDelta - originalMrrDelta;
                await this._MemberPaidSubscriptionEvent.add({
                    member_id: member.id,
                    source: 'stripe',
                    from_plan: model.get('plan_id'),
                    to_plan: updated.get('plan_id'),
                    currency: subscriptionPriceData.currency,
                    mrr_delta: mrrDelta
                }, options);
            }
        } else {
            await this._StripeCustomerSubscription.add(subscriptionData, options);
            await this._MemberPaidSubscriptionEvent.add({
                member_id: member.id,
                source: 'stripe',
                from_plan: null,
                to_plan: subscriptionPriceData.id,
                currency: subscriptionPriceData.currency,
                mrr_delta: getMRRDelta({interval: _.get(subscriptionPriceData, 'recurring.interval'), amount: subscriptionPriceData.unit_amount, status: subscriptionPriceData.status})
            }, options);
        }

        let status = 'free';
        let memberProducts = [];
        if (this.isActiveSubscriptionStatus(subscription.status)) {
            status = 'paid';
            try {
                if (ghostProduct) {
                    memberProducts.push(ghostProduct.toJSON());
                }
                const existingProducts = await member.related('products').fetch(options);
                for (const productModel of existingProducts.models) {
                    memberProducts.push(productModel.toJSON());
                }
            } catch (e) {
                this._logging.error(`Failed to attach products to member - ${data.id}`);
            }
        } else {
            const subscriptions = await member.related('stripeSubscriptions').fetch(options);
            for (const subscription of subscriptions.models) {
                if (this.isActiveSubscriptionStatus(subscription.get('status'))) {
                    try {
                        const subscriptionProduct = await this._productRepository.get({stripe_price_id: subscription.get('stripe_price_id')});
                        if (subscriptionProduct) {
                            memberProducts.push(subscriptionProduct.toJSON());
                        }
                    } catch (e) {
                        this._logging.error(`Failed to attach products to member - ${data.id}`);
                        this._logging.error(e);
                    }
                    status = 'paid';
                }
            }
        }
        let updatedMember;
        try {
            // Remove duplicate products from the list
            memberProducts = _.uniqBy(memberProducts, function (e) {
                return e.id;
            });
            // Edit member with updated products assoicated
            updatedMember = await this._Member.edit({status: status, products: memberProducts}, {...options, id: data.id});
        } catch (e) {
            this._logging.error(`Failed to update member - ${data.id} - with related products`);
            this._logging.error(e);
            updatedMember = await this._Member.edit({status: status}, {...options, id: data.id});
        }
        if (updatedMember.attributes.status !== updatedMember._previousAttributes.status) {
            await this._MemberStatusEvent.add({
                member_id: data.id,
                from_status: updatedMember._previousAttributes.status,
                to_status: updatedMember.get('status')
            }, options);
        }
    }

    async getSubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot get Stripe Subscription with no Stripe Connection');
        }

        const member = await this._Member.findOne({
            email: data.email
        });

        const subscription = await member.related('stripeSubscriptions').query({
            where: {
                subscription_id: data.subscription.subscription_id
            }
        }).fetchOne(options);

        if (!subscription) {
            throw new Error('Subscription not found');
        }

        return subscription.toJSON();
    }

    async cancelSubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot update Stripe Subscription with no Stripe Connection');
        }

        const member = await this._Member.findOne({
            email: data.email
        });

        const subscription = await member.related('stripeSubscriptions').query({
            where: {
                subscription_id: data.subscription.subscription_id
            }
        }).fetchOne(options);

        if (!subscription) {
            throw new Error('Subscription not found');
        }

        const updatedSubscription = await this._stripeAPIService.cancelSubscription(data.subscription.subscription_id);

        await this.linkSubscription({
            id: member.id,
            subscription: updatedSubscription
        }, options);
    }

    async updateSubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot update Stripe Subscription with no Stripe Connection');
        }

        let findQuery = null;
        if (data.id) {
            findQuery = {id: data.id};
        } else if (data.email) {
            findQuery = {email: data.email};
        }

        if (!findQuery) {
            throw new Error('Cannot update Subscription without an id or email for the Member');
        }

        const member = await this._Member.findOne(findQuery);

        const subscriptionModel = await member.related('stripeSubscriptions').query({
            where: {
                subscription_id: data.subscription.subscription_id
            }
        }).fetchOne(options);

        if (!subscriptionModel) {
            throw new Error('Subscription not found');
        }

        let updatedSubscription;
        if (data.subscription.price) {
            const subscription = await this._stripeAPIService.getSubscription(
                data.subscription.subscription_id
            );

            const subscriptionItem = subscription.items.data[0];

            updatedSubscription = await this._stripeAPIService.updateSubscriptionItemPrice(
                subscription.id,
                subscriptionItem.id,
                data.subscription.price
            );
        }

        if (data.subscription.cancel_at_period_end !== undefined) {
            if (data.subscription.cancel_at_period_end) {
                updatedSubscription = await this._stripeAPIService.cancelSubscriptionAtPeriodEnd(
                    data.subscription.subscription_id,
                    data.subscription.cancellationReason
                );
            } else {
                updatedSubscription = await this._stripeAPIService.continueSubscriptionAtPeriodEnd(
                    data.subscription.subscription_id
                );
            }
        }

        if (updatedSubscription) {
            await this.linkSubscription({
                id: member.id,
                subscription: updatedSubscription
            }, options);
        }
    }

    async createSubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot create Stripe Subscription with no Stripe Connection');
        }
        const member = await this._Member.findOne({
            id: data.id
        }, options);

        let stripeCustomer;

        await member.related('stripeCustomers').fetch(options);

        for (const customer of member.related('stripeCustomers').models) {
            try {
                const fetchedCustomer = await this._stripeAPIService.getCustomer(customer.get('customer_id'));
                stripeCustomer = fetchedCustomer;
            } catch (err) {
                console.log('Ignoring error for fetching customer for checkout');
            }
        }

        if (!stripeCustomer) {
            stripeCustomer = await this._stripeAPIService.createCustomer({
                email: member.get('email')
            });

            await this._StripeCustomer.add({
                customer_id: stripeCustomer.id,
                member_id: data.id,
                email: stripeCustomer.email,
                name: stripeCustomer.name
            }, options);
        }

        const subscription = await this._stripeAPIService.createSubscription(stripeCustomer.id, data.subscription.stripe_price_id);

        await this.linkSubscription({
            id: member.id,
            subscription
        }, options);
    }

    async setComplimentarySubscription(data, options) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot update Stripe Subscription with no Stripe Connection');
        }
        const member = await this._Member.findOne({
            id: data.id
        }, options);

        const subscriptions = await member.related('stripeSubscriptions').fetch(options);

        const activeSubscriptions = subscriptions.models.filter((subscription) => {
            return this.isActiveSubscriptionStatus(subscription.get('status'));
        });

        const productPage = await this._productRepository.list({limit: 1, withRelated: ['stripePrices'], ...options});

        const defaultProduct = productPage && productPage.data && productPage.data[0] && productPage.data[0].toJSON();

        if (!defaultProduct) {
            throw new Error('Could not find default product');
        }

        const zeroValuePrices = defaultProduct.stripePrices.filter((price) => {
            return price.amount === 0;
        });

        if (activeSubscriptions.length) {
            for (const subscription of activeSubscriptions) {
                const price = await subscription.related('stripePrice').fetch(options);

                let zeroValuePrice = zeroValuePrices.find((p) => {
                    return p.currency.toLowerCase() === price.get('currency').toLowerCase();
                });

                if (!zeroValuePrice) {
                    const product = (await this._productRepository.update({
                        id: defaultProduct.id,
                        name: defaultProduct.name,
                        description: defaultProduct.description,
                        stripe_prices: [{
                            nickname: 'Complimentary',
                            currency: price.get('currency'),
                            type: 'recurring',
                            interval: 'year',
                            amount: 0
                        }]
                    }, options)).toJSON();
                    zeroValuePrice = product.stripePrices.find((p) => {
                        return p.currency.toLowerCase() === price.get('currency').toLowerCase() && p.amount === 0;
                    });
                    zeroValuePrices.push(zeroValuePrice);
                }

                const stripeSubscription = await this._stripeAPIService.getSubscription(
                    subscription.get('subscription_id')
                );

                const subscriptionItem = stripeSubscription.items.data[0];

                const updatedSubscription = await this._stripeAPIService.updateSubscriptionItemPrice(
                    stripeSubscription.id,
                    subscriptionItem.id,
                    zeroValuePrice.stripe_price_id
                );

                await this.linkSubscription({
                    id: member.id,
                    subscription: updatedSubscription
                }, options);
            }
        } else {
            const stripeCustomer = await this._stripeAPIService.createCustomer({
                email: member.get('email')
            });

            await this._StripeCustomer.upsert({
                customer_id: stripeCustomer.id,
                member_id: data.id,
                email: stripeCustomer.email,
                name: stripeCustomer.name
            }, options);

            let zeroValuePrice = zeroValuePrices[0];

            if (!zeroValuePrice) {
                const product = (await this._productRepository.update({
                    id: defaultProduct.id,
                    name: defaultProduct.name,
                    description: defaultProduct.description,
                    stripe_prices: [{
                        nickname: 'Complimentary',
                        currency: 'USD',
                        type: 'recurring',
                        interval: 'year',
                        amount: 0
                    }]
                }, options)).toJSON();
                zeroValuePrice = product.stripePrices.find((price) => {
                    return price.currency.toLowerCase() === 'usd' && price.amount === 0;
                });
                zeroValuePrices.push(zeroValuePrice);
            }

            const subscription = await this._stripeAPIService.createSubscription(
                stripeCustomer.id,
                zeroValuePrice.stripe_price_id
            );

            await this.linkSubscription({
                id: member.id,
                subscription
            }, options);
        }
    }

    async cancelComplimentarySubscription(data) {
        if (!this._stripeAPIService.configured) {
            throw new Error('Cannot cancel Complimentary Subscription with no Stripe Connection');
        }

        const member = await this._Member.findOne({
            id: data.id
        });

        const subscriptions = await member.related('stripeSubscriptions').fetch();

        for (const subscription of subscriptions.models) {
            if (subscription.get('status') !== 'canceled') {
                try {
                    const updatedSubscription = await this._stripeAPIService.cancelSubscription(
                        subscription.get('subscription_id')
                    );
                    // Only needs to update `status`
                    await this.linkSubscription({
                        id: data.id,
                        subscription: updatedSubscription
                    });
                } catch (err) {
                    this._logging.error(`There was an error cancelling subscription ${subscription.get('subscription_id')}`);
                    this._logging.error(err);
                }
            }
        }
        return true;
    }
};

function getMRRDelta({interval, amount, status = null}) {
    if (status === 'trialing') {
        return 0;
    }
    if (status === 'incomplete') {
        return 0;
    }
    if (status === 'incomplete_expired') {
        return 0;
    }
    if (status === 'canceled') {
        return 0;
    }

    if (interval === 'year') {
        return Math.floor(amount / 12);
    }

    if (interval === 'month') {
        return amount;
    }

    if (interval === 'week') {
        return amount * 4;
    }

    if (interval === 'day') {
        return amount * 30;
    }
}

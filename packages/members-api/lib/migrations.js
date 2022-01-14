const _ = require('lodash');
const logging = require('@tryghost/logging');

module.exports = class StripeMigrations {
    /**
     * StripeMigrations
     *
     * @param {object} params
     *
     * @param {any} params.StripeCustomerSubscription
     * @param {any} params.StripeProduct
     * @param {any} params.StripePrice
     * @param {any} params.Product
     * @param {any} params.Settings
     * @param {import('../services/stripe-api')} params.stripeAPIService
     */
    constructor({
        StripeCustomerSubscription,
        StripeProduct,
        StripePrice,
        Product,
        Settings,
        stripeAPIService
    }) {
        this._StripeCustomerSubscription = StripeCustomerSubscription;
        this._StripeProduct = StripeProduct;
        this._StripePrice = StripePrice;
        this._Product = Product;
        this._Settings = Settings;
        this._stripeAPIService = stripeAPIService;
    }

    async populateProductsAndPrices(options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.populateProductsAndPrices({transacting});
            });
        }
        const subscriptionModels = await this._StripeCustomerSubscription.findAll(options);
        const priceModels = await this._StripePrice.findAll(options);
        const productModels = await this._StripeProduct.findAll(options);
        const subscriptions = subscriptionModels.toJSON();
        const prices = priceModels.toJSON();
        const products = productModels.toJSON();
        const {data} = await this._Product.findPage({
            ...options,
            limit: 1,
            filter: 'type:paid'
        });
        const defaultProduct = data[0] && data[0].toJSON();

        if (subscriptions.length > 0 && products.length === 0 && prices.length === 0 && defaultProduct) {
            try {
                logging.info(`Populating products and prices for existing stripe customers`);
                const uniquePlans = _.uniq(subscriptions.map(d => _.get(d, 'plan.id')));

                let stripePrices = [];
                for (const plan of uniquePlans) {
                    try {
                        const stripePrice = await this._stripeAPIService.getPrice(plan, {
                            expand: ['product']
                        });
                        stripePrices.push(stripePrice);
                    } catch (err) {
                        if (err && err.statusCode === 404) {
                            logging.warn(`Plan ${plan} not found on Stripe - ignoring`);
                        } else {
                            throw err;
                        }
                    }
                }
                logging.info(`Adding ${stripePrices.length} prices from Stripe`);
                for (const stripePrice of stripePrices) {
                    // We expanded the product when fetching this price.
                    /** @type {import('stripe').Stripe.Product} */
                    const stripeProduct = (stripePrice.product);

                    await this._StripeProduct.upsert({
                        product_id: defaultProduct.id,
                        stripe_product_id: stripeProduct.id
                    }, options);

                    await this._StripePrice.add({
                        stripe_price_id: stripePrice.id,
                        stripe_product_id: stripeProduct.id,
                        active: stripePrice.active,
                        nickname: stripePrice.nickname,
                        currency: stripePrice.currency,
                        amount: stripePrice.unit_amount,
                        type: 'recurring',
                        interval: stripePrice.recurring.interval
                    }, options);
                }
            } catch (e) {
                logging.error(`Failed to populate products/prices from stripe`);
                logging.error(e);
            }
        }
    }

    async findPriceByPlan(plan, options) {
        const currency = plan.currency ? plan.currency.toLowerCase() : 'usd';
        const amount = Number.isInteger(plan.amount) ? plan.amount : parseInt(plan.amount);
        const interval = plan.interval;

        const price = await this._StripePrice.findOne({
            currency,
            amount,
            interval
        }, options);

        return price;
    }

    async getPlanFromPrice(priceId, options) {
        const price = await this._StripePrice.findOne({
            id: priceId
        }, options);

        if (price && price.get('interval') === 'month') {
            return 'monthly';
        }
        if (price && price.get('interval') === 'year') {
            return 'yearly';
        }
        return null;
    }

    async populateStripePricesFromStripePlansSetting(plans, options) {
        if (!plans) {
            logging.info('Skipping stripe_plans -> stripe_prices migration');
            return;
        }

        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.populateStripePricesFromStripePlansSetting(plans, {transacting});
            });
        }
        let defaultStripeProduct;
        const stripeProductsPage = await this._StripeProduct.findPage({...options, limit: 1});
        defaultStripeProduct = stripeProductsPage.data[0];

        if (!defaultStripeProduct) {
            logging.info('Could not find Stripe Product - creating one');
            const productsPage = await this._Product.findPage({
                ...options,
                limit: 1,
                filter: 'type:paid'
            });
            const defaultProduct = productsPage.data[0];
            const stripeProduct = await this._stripeAPIService.createProduct({
                name: defaultProduct.get('name')
            });
            if (!defaultProduct) {
                logging.error('Could not find Product - skipping stripe_plans -> stripe_prices migration');
                return;
            }
            defaultStripeProduct = await this._StripeProduct.add({
                product_id: defaultProduct.id,
                stripe_product_id: stripeProduct.id
            }, options);
        }

        for (const plan of plans) {
            const price = await this.findPriceByPlan(plan, options);

            if (!price) {
                logging.info(`Could not find Stripe Price ${JSON.stringify(plan)}`);

                try {
                    logging.info(`Creating Stripe Price ${JSON.stringify(plan)}`);
                    const price = await this._stripeAPIService.createPrice({
                        currency: plan.currency,
                        amount: plan.amount,
                        nickname: plan.name,
                        interval: plan.interval,
                        active: true,
                        type: 'recurring',
                        product: defaultStripeProduct.get('stripe_product_id')
                    });

                    await this._StripePrice.add({
                        stripe_price_id: price.id,
                        stripe_product_id: defaultStripeProduct.get('stripe_product_id'),
                        active: price.active,
                        nickname: price.nickname,
                        currency: price.currency,
                        amount: price.unit_amount,
                        type: 'recurring',
                        interval: price.recurring.interval
                    }, options);
                } catch (err) {
                    logging.error({err, message: 'Adding price failed'});
                }
            }
        }
    }

    async updatePortalPlansSetting(plans, options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.updatePortalPlansSetting(plans, {transacting});
            });
        }
        logging.info('Migrating portal_plans setting from names to ids');
        const portalPlansSetting = await this._Settings.findOne({key: 'portal_plans'}, options);

        let portalPlans;
        try {
            portalPlans = JSON.parse(portalPlansSetting.get('value'));
        } catch (err) {
            logging.error({
                message: 'Could not parse portal_plans setting, skipping migration',
                err
            });
            return;
        }

        const containsOldValues = !!portalPlans.find((plan) => {
            return ['monthly', 'yearly'].includes(plan);
        });

        if (!containsOldValues) {
            logging.info('Could not find names in portal_plans setting, skipping migration');
            return;
        }

        const newPortalPlans = await portalPlans.reduce(async (newPortalPlansPromise, plan) => {
            let newPlan = plan;
            if (plan === 'monthly') {
                const monthlyPlan = plans.find((plan) => {
                    return plan.name === 'Monthly';
                });
                if (!monthlyPlan) {
                    return newPortalPlansPromise;
                }
                const price = await this.findPriceByPlan(monthlyPlan, options);
                newPlan = price.id;
            }
            if (plan === 'yearly') {
                const yearlyPlan = plans.find((plan) => {
                    return plan.name === 'Yearly';
                });
                if (!yearlyPlan) {
                    return newPortalPlansPromise;
                }
                const price = await this.findPriceByPlan(yearlyPlan, options);
                newPlan = price.id;
            }
            const newPortalPlans = await newPortalPlansPromise;
            return newPortalPlans.concat(newPlan);
        }, []);

        logging.info(`Updating portal_plans setting to ${JSON.stringify(newPortalPlans)}`);
        await this._Settings.edit({
            key: 'portal_plans',
            value: JSON.stringify(newPortalPlans)
        }, {
            ...options,
            id: portalPlansSetting.id
        });
    }

    async populateMembersMonthlyPriceIdSettings(options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.populateMembersMonthlyPriceIdSettings({transacting});
            });
        }
        logging.info('Populating members_monthly_price_id from stripe_plans');
        const monthlyPriceId = await this._Settings.findOne({key: 'members_monthly_price_id'}, options);

        if (monthlyPriceId.get('value')) {
            logging.info('Skipping population of members_monthly_price_id, already populated');
            return;
        }

        const stripePlans = await this._Settings.findOne({key: 'stripe_plans'}, options);
        let plans;
        try {
            plans = JSON.parse(stripePlans.get('value'));
        } catch (err) {
            logging.warn('Skipping population of members_monthly_price_id, could not parse stripe_plans');
            return;
        }

        const monthlyPlan = plans.find((plan) => {
            return plan.name === 'Monthly';
        });

        if (!monthlyPlan) {
            logging.warn('Skipping population of members_monthly_price_id, could not find Monthly plan');
            return;
        }

        let monthlyPrice;

        monthlyPrice = await this._StripePrice.findOne({
            amount: monthlyPlan.amount,
            currency: monthlyPlan.currency,
            interval: monthlyPlan.interval,
            active: true
        }, options);

        if (!monthlyPrice) {
            logging.info('Could not find active Monthly price from stripe_plans - searching by interval');
            monthlyPrice = await this._StripePrice.where('amount', '>', 0)
                .where({interval: 'month', active: true}).fetch(options);
        }

        if (!monthlyPrice) {
            logging.info('Could not any active Monthly price - creating a new one');
            let defaultStripeProduct;
            const stripeProductsPage = await this._StripeProduct.findPage({...options, limit: 1});
            defaultStripeProduct = stripeProductsPage.data[0];
            const price = await this._stripeAPIService.createPrice({
                currency: 'usd',
                amount: 5000,
                nickname: 'Monthly',
                interval: 'month',
                active: true,
                type: 'recurring',
                product: defaultStripeProduct.get('stripe_product_id')
            });

            monthlyPrice = await this._StripePrice.add({
                stripe_price_id: price.id,
                stripe_product_id: defaultStripeProduct.get('stripe_product_id'),
                active: price.active,
                nickname: price.nickname,
                currency: price.currency,
                amount: price.unit_amount,
                type: 'recurring',
                interval: price.recurring.interval
            }, options);
        }

        await this._Settings.edit({key: 'members_monthly_price_id', value: monthlyPrice.id}, {...options, id: monthlyPriceId.id});
    }

    async populateMembersYearlyPriceIdSettings(options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.populateMembersYearlyPriceIdSettings({transacting});
            });
        }
        logging.info('Populating members_yearly_price_id from stripe_plans');
        const yearlyPriceId = await this._Settings.findOne({key: 'members_yearly_price_id'}, options);

        if (yearlyPriceId.get('value')) {
            logging.info('Skipping population of members_yearly_price_id, already populated');
            return;
        }

        const stripePlans = await this._Settings.findOne({key: 'stripe_plans'}, options);
        let plans;
        try {
            plans = JSON.parse(stripePlans.get('value'));
        } catch (err) {
            logging.warn('Skipping population of members_yearly_price_id, could not parse stripe_plans');
        }

        const yearlyPlan = plans.find((plan) => {
            return plan.name === 'Yearly';
        });

        if (!yearlyPlan) {
            logging.warn('Skipping population of members_yearly_price_id, could not find yearly plan');
            return;
        }

        let yearlyPrice;

        yearlyPrice = await this._StripePrice.findOne({
            amount: yearlyPlan.amount,
            currency: yearlyPlan.currency,
            interval: yearlyPlan.interval,
            active: true
        }, options);

        if (!yearlyPrice) {
            logging.info('Could not find active yearly price from stripe_plans - searching by interval');
            yearlyPrice = await this._StripePrice.where('amount', '>', 0)
                .where({interval: 'year', active: true}).fetch(options);
        }

        if (!yearlyPrice) {
            logging.info('Could not any active yearly price - creating a new one');
            let defaultStripeProduct;
            const stripeProductsPage = await this._StripeProduct.findPage({...options, limit: 1});
            defaultStripeProduct = stripeProductsPage.data[0];
            const price = await this._stripeAPIService.createPrice({
                currency: 'usd',
                amount: 500,
                nickname: 'Yearly',
                interval: 'year',
                active: true,
                type: 'recurring',
                product: defaultStripeProduct.get('stripe_product_id')
            });

            yearlyPrice = await this._StripePrice.add({
                stripe_price_id: price.id,
                stripe_product_id: defaultStripeProduct.get('stripe_product_id'),
                active: price.active,
                nickname: price.nickname,
                currency: price.currency,
                amount: price.unit_amount,
                type: 'recurring',
                interval: price.recurring.interval
            }, options);
        }

        await this._Settings.edit({key: 'members_yearly_price_id', value: yearlyPrice.id}, {...options, id: yearlyPriceId.id});
    }

    async populateDefaultProductMonthlyPriceId(options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.populateDefaultProductMonthlyPriceId({transacting});
            });
        }
        logging.info('Migrating members_monthly_price_id setting to monthly_price_id column');
        const productsPage = await this._Product.findPage({
            ...options, limit: 1,
            filter: 'type:paid'
        });
        const defaultProduct = productsPage.data[0];

        if (defaultProduct.get('monthly_price_id')) {
            logging.warn('Skipping migration, monthly_price_id already set');
            return;
        }

        const monthlyPriceIdSetting = await this._Settings.findOne({key: 'members_monthly_price_id'}, options);
        const monthlyPriceId = monthlyPriceIdSetting.get('value');

        await this._Product.edit({monthly_price_id: monthlyPriceId}, {...options, id: defaultProduct.id});
    }

    async populateDefaultProductYearlyPriceId(options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.populateDefaultProductYearlyPriceId({transacting});
            });
        }
        logging.info('Migrating members_yearly_price_id setting to yearly_price_id column');
        const productsPage = await this._Product.findPage({
            ...options,
            limit: 1,
            filter: 'type:paid'
        });
        const defaultProduct = productsPage.data[0];

        if (defaultProduct.get('yearly_price_id')) {
            logging.warn('Skipping migration, yearly_price_id already set');
            return;
        }

        const yearlyPriceIdSetting = await this._Settings.findOne({key: 'members_yearly_price_id'}, options);
        const yearlyPriceId = yearlyPriceIdSetting.get('value');

        await this._Product.edit({yearly_price_id: yearlyPriceId}, {...options, id: defaultProduct.id});
    }

    async revertPortalPlansSetting(options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.revertPortalPlansSetting({transacting});
            });
        }
        logging.info('Migrating portal_plans setting from ids to names');
        const portalPlansSetting = await this._Settings.findOne({key: 'portal_plans'}, options);

        let portalPlans;
        try {
            portalPlans = JSON.parse(portalPlansSetting.get('value'));
        } catch (err) {
            logging.error({
                message: 'Could not parse portal_plans setting, skipping migration',
                err
            });
            return;
        }

        const containsNamedValues = !!portalPlans.find((plan) => {
            return ['monthly', 'yearly'].includes(plan);
        });

        if (containsNamedValues) {
            logging.info('The portal_plans setting already contains names, skipping migration');
            return;
        }
        const portalPlanIds = portalPlans.filter((plan) => {
            return plan !== 'free';
        });

        if (portalPlanIds.length === 0) {
            logging.info('No price ids found in portal_plans setting, skipping migration');
            return;
        }
        const defaultPortalPlans = portalPlans.filter((plan) => {
            return plan === 'free';
        });

        const newPortalPlans = await portalPlanIds.reduce(async (newPortalPlansPromise, priceId) => {
            const plan = await this.getPlanFromPrice(priceId, options);

            if (!plan) {
                return newPortalPlansPromise;
            }

            const newPortalPlans = await newPortalPlansPromise;
            const updatedPortalPlans = newPortalPlans.filter(d => d !== plan).concat(plan);

            return updatedPortalPlans;
        }, defaultPortalPlans);
        logging.info(`Updating portal_plans setting to ${JSON.stringify(newPortalPlans)}`);
        await this._Settings.edit({
            key: 'portal_plans',
            value: JSON.stringify(newPortalPlans)
        }, {
            ...options,
            id: portalPlansSetting.id
        });
    }

    async removeInvalidSubscriptions(options) {
        if (!options) {
            return this._Product.transaction((transacting) => {
                return this.removeInvalidSubscriptions({transacting});
            });
        }
        const subscriptionModels = await this._StripeCustomerSubscription.findAll({
            ...options,
            withRelated: ['stripePrice']
        });
        const invalidSubscriptions = subscriptionModels.filter((sub) => {
            return !sub.toJSON().price;
        });
        if (invalidSubscriptions.length > 0) {
            logging.warn(`Deleting ${invalidSubscriptions.length} invalid subscription(s)`);
            for (let sub of invalidSubscriptions) {
                logging.warn(`Deleting subscription - ${sub.id} - no price found`);
                await sub.destroy(options);
            }
        } else {
            logging.info(`No invalid subscriptions, skipping migration`);
        }
    }
};

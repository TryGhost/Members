const _ = require('lodash');

/**
 * @typedef {object} ILogger
 * @prop {(x: any) => void} error
 * @prop {(x: any) => void} info
 * @prop {(x: any) => void} warn
 */
module.exports = class StripeMigrations {
    /**
     * StripeMigrations
     *
     * @param {object} params
     *
     * @param {ILogger} params.logger
     * @param {any} params.StripeCustomerSubscription
     * @param {any} params.StripeProduct
     * @param {any} params.StripePrice
     * @param {any} params.Product
     * @param {any} params.stripeAPIService
     */
    constructor({
        StripeCustomerSubscription,
        StripeProduct,
        StripePrice,
        Product,
        stripeAPIService,
        logger
    }) {
        this._logging = logger;
        this._StripeCustomerSubscription = StripeCustomerSubscription;
        this._StripeProduct = StripeProduct;
        this._StripePrice = StripePrice;
        this._Product = Product;
        this._StripeAPIService = stripeAPIService;
    }

    async populateProductsAndPrices() {
        const subscriptionModels = await this._StripeCustomerSubscription.findAll();
        const priceModels = await this._StripePrice.findAll();
        const productModels = await this._StripeProduct.findAll();
        const subscriptions = subscriptionModels.toJSON();
        const prices = priceModels.toJSON();
        const products = productModels.toJSON();
        const {data} = await this._Product.findPage({
            limit: 1
        });
        const defaultProduct = data[0] && data[0].toJSON();

        /** Only run when -
         * No rows in stripe_products,
         * No rows in stripe_prices,
         * One or more rows in members_stripe_customers_subscriptions
         * */
        if (subscriptions.length > 0 && products.length === 0 && prices.length === 0) {
            const uniquePlans = _.uniq(subscriptions.map(d => _.get(d, 'plan.id')));

            let stripePlans = [];
            this._logging.info(`Adding ${uniquePlans.length} plans from Stripe`);
            for (const plan of uniquePlans) {
                const stripePlan = await this._StripeAPIService.getPlan(plan, {
                    expand: ['product']
                });
                const stripeProduct = stripePlan.product;

                await this._StripeProduct.upsert({
                    product_id: defaultProduct.id,
                    stripe_product_id: stripeProduct.id
                });

                await this._StripePrice.add({
                    stripe_price_id: stripePlan.id,
                    stripe_product_id: stripeProduct.id,
                    active: stripePlan.active,
                    nickname: stripePlan.nickname,
                    currency: stripePlan.currency,
                    amount: stripePlan.amount,
                    type: 'recurring',
                    interval: stripePlan.interval
                });

                stripePlans.push(stripePlan);
            }
        }
    }
};

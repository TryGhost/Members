export = StripeService;
declare class StripeService {
    constructor({ config, logger }: {
        logger: ILogger;
        config: {
            secretKey: string;
            publicKey: string;
            checkoutSuccessUrl: string;
            checkoutCancelUrl: string;
            billingSuccessUrl: string;
            billingCancelUrl: string;
            appInfo: {
                name: string;
                version: string;
                partner_id: string;
                url: string;
            };
            enablePromoCodes: boolean;
        };
    });
    _stripe: Stripe;
    _config: {
        secretKey: string;
        publicKey: string;
        checkoutSuccessUrl: string;
        checkoutCancelUrl: string;
        billingSuccessUrl: string;
        billingCancelUrl: string;
        appInfo: {
            name: string;
            version: string;
            partner_id: string;
            url: string;
        };
        enablePromoCodes: boolean;
    };
    _testMode: boolean;
    _rateLimitBucket: any;
    logging: ILogger;
    ensureProduct(name: string): Promise<IProduct>;
    ensurePlan(plan: object, product: object): Promise<IPlan>;
    getCustomer(id: string, options?: IDataOptions): Promise<ICustomer>;
    createCustomer(options?: IDataOptions): Promise<ICustomer>;
    updateCustomerEmail(id: string, email: string): Promise<ICustomer>;
    createWebhookEndpoint(url: string): Promise<IWebhookEndpoint>;
    deleteWebhookEndpoint(id: string): Promise<void>;
    updateWebhookEndpoint(id: string, url: string): Promise<IWebhookEndpoint>;
    parseWebhook(body: string, signature: string, secret: string): import('stripe').events.IEvent;
    createCheckoutSession(plan: IPlan, customer: ICustomer, options: object): Promise<import('stripe').checkouts.sessions.ICheckoutSession>;
    createCheckoutSetupSession(customer: ICustomer, options: object): Promise<import('stripe').checkouts.sessions.ICheckoutSession>;
    getPublicKey(): string;
    getSubscription(id: string, options?: IDataOptions): Promise<import('stripe').subscriptions.ISubscription>;
    cancelSubscriptionAtPeriodEnd(id: string, reason?: string): Promise<import('stripe').subscriptions.ISubscription>;
    continueSubscriptionAtPeriodEnd(id: string): Promise<import('stripe').subscriptions.ISubscription>;
    changeSubscriptionPlan(id: string, plan: string): Promise<import('stripe').subscriptions.ISubscription>;
}
declare namespace StripeService {
    export { IDataOptions, ICustomer, IProduct, IPlan, IWebhookEndpoint, ILogger, StripeResource };
}
import Stripe = require("stripe");
type ILogger = {
    error: (x: any) => void;
    info: (x: any) => void;
    warn: (x: any) => void;
};
type IProduct = Stripe.products.IProduct;
type IPlan = Stripe.plans.IPlan;
type IDataOptions = Stripe.IDataOptions;
type ICustomer = Stripe.customers.ICustomer;
type IWebhookEndpoint = Stripe.webhookEndpoints.IWebhookEndpoint;
type StripeResource = "customers" | "subscriptions" | "plans";

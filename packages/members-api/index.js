const _ = require('lodash');
const {Router} = require('express');
const body = require('body-parser');
const MagicLink = require('@tryghost/magic-link');
const StripePaymentProcessor = require('./lib/stripe');

const Tokens = require('./lib/tokens');
const Users = require('./lib/users');
const Metadata = require('./lib/metadata');
const common = require('./lib/common');

module.exports = function MembersApi({
    tokenConfig: {
        issuer,
        privateKey,
        publicKey
    },
    auth: {
        allowSelfSignup = true,
        getSigninURL,
        secret
    },
    paymentConfig,
    mail: {
        transporter,
        getText,
        getHTML,
        getSubject
    },
    memberStripeCustomerModel,
    stripeCustomerSubscriptionModel,
    memberModel,
    logger
}) {
    if (logger) {
        common.logging.setLogger(logger);
    }

    const {encodeIdentityToken, decodeToken} = Tokens({privateKey, publicKey, issuer});
    const metadata = Metadata({memberStripeCustomerModel, stripeCustomerSubscriptionModel});

    const stripeStorage = {
        async get(member) {
            return metadata.getMetadata('stripe', member);
        },
        async set(data) {
            return metadata.setMetadata('stripe', data);
        }
    };
    const stripe = paymentConfig.stripe ? new StripePaymentProcessor(paymentConfig.stripe, stripeStorage, common.logging) : null;

    async function ensureStripe(_req, res, next) {
        if (!stripe) {
            res.writeHead(400);
            return res.end('Stripe not configured');
        }
        try {
            await stripe.ready();
            next();
        } catch (err) {
            res.writeHead(500);
            return res.end('There was an error configuring stripe');
        }
    }

    const magicLinkService = new MagicLink({
        transporter,
        secret,
        getSigninURL,
        getText,
        getHTML,
        getSubject
    });

    async function sendEmailWithMagicLink(email, requestedType, options = {forceEmailType: false}){
        if (options.forceEmailType) {
            return magicLinkService.sendMagicLink({email, subject: email, type: requestedType});
        }
        const member = await users.get({email});
        if (member) {
            return magicLinkService.sendMagicLink({email, subject: email, type: 'signin'});
        } else {
            const type = requestedType === 'subscribe' ? 'subscribe' : 'signup';
            return magicLinkService.sendMagicLink({email, subject: email, type});
        }
    }

    const users = Users({
        stripe,
        memberModel
    });

    async function getMemberDataFromMagicLinkToken(token){
        const email = await magicLinkService.getUserFromToken(token);
        if (!email) {
            return null;
        }
        const member = await getMemberIdentityData(email);
        if (member) {
            return member;
        }
        await users.create({email});
        return getMemberIdentityData(email);
    }
    async function getMemberIdentityData(email){
        return users.get({email});
    }
    async function getMemberIdentityToken(email){
        const member = await getMemberIdentityData(email);
        if (!member) {
            return null;
        }
        return encodeIdentityToken({sub: member.email});
    }

    const middleware = {
        sendMagicLink: Router(),
        createCheckoutSession: Router(),
        handleStripeWebhook: Router(),
        updateSubscription: Router({mergeParams: true})
    };

    middleware.sendMagicLink.use(body.json(), async function (req, res) {
        const email = req.body.email;
        if (!email) {
            res.writeHead(400);
            return res.end('Bad Request.');
        }
        const emailType = req.body.emailType;
        try {
            if (!allowSelfSignup) {
                const member = await users.get({email});
                if (member) {
                    await sendEmailWithMagicLink(email, emailType);
                }
            } else {
                await sendEmailWithMagicLink(email, emailType);
            }
            res.writeHead(201);
            return res.end('Created.');
        } catch (err) {
            common.logging.error(err);
            res.writeHead(500);
            return res.end('Internal Server Error.');
        }
    });

    middleware.createCheckoutSession.use(ensureStripe, body.json(), async function (req, res) {
        const plan = req.body.plan;
        const identity = req.body.identity;

        if (!plan) {
            res.writeHead(400);
            return res.end('Bad Request.');
        }

        // NOTE: never allow "Complimenatry" plan to be subscribed to from the client
        if (plan.toLowerCase() === 'complimentary') {
            res.writeHead(400);
            return res.end('Bad Request.');
        }

        let email;
        try {
            if (!identity) {
                email = null;
            } else {
                const claims = await decodeToken(identity);
                email = claims.sub;
            }
        } catch (err) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        const member = email ? await users.get({email}) : null;

        // Do not allow members already with a subscription to initiate a new checkout session
        if (member && member.stripe.subscriptions.length > 0) {
            res.writeHead(403);
            return res.end('No permission');
        }

        const sessionInfo = await stripe.createCheckoutSession(member, plan, {
            successUrl: req.body.successUrl,
            cancelUrl: req.body.cancelUrl
        });

        res.writeHead(200, {
            'Content-Type': 'application/json'
        });

        res.end(JSON.stringify(sessionInfo));
    });

    middleware.handleStripeWebhook.use(ensureStripe, body.raw({type: 'application/json'}), async function (req, res) {
        let event;
        try {
            event = await stripe.parseWebhook(req.body, req.headers['stripe-signature']);
        } catch (err) {
            common.logging.error(err);
            res.writeHead(401);
            return res.end();
        }
        try {
            if (event.type === 'customer.subscription.deleted') {
                await stripe.handleCustomerSubscriptionDeletedWebhook(event.data.object);
            }

            if (event.type === 'customer.subscription.updated') {
                await stripe.handleCustomerSubscriptionUpdatedWebhook(event.data.object);
            }

            if (event.type === 'invoice.payment_succeeded') {
                await stripe.handleInvoicePaymentSucceededWebhook(event.data.object);
            }

            if (event.type === 'invoice.payment_failed') {
                await stripe.handleInvoicePaymentFailedWebhook(event.data.object);
            }

            if (event.type === 'checkout.session.completed') {
                const customer = await stripe.getCustomer(event.data.object.customer, {
                    expand: ['subscriptions.data.default_payment_method']
                });

                const member = await users.get({email: customer.email}) || await users.create({email: customer.email});
                await stripe.handleCheckoutSessionCompletedWebhook(member, customer);

                const payerName = _.get(customer, 'subscriptions.data[0].default_payment_method.billing_details.name');

                if (payerName && !member.name) {
                    await users.update({name: payerName}, {id: member.id});
                }

                const emailType = 'signup';
                await sendEmailWithMagicLink(customer.email, emailType, {forceEmailType: true});
            }

            res.writeHead(200);
            res.end();
        } catch (err) {
            common.logging.error(`Error handling webhook ${event.type}`, err);
            res.writeHead(400);
            res.end();
        }
    });

    middleware.updateSubscription.use(ensureStripe, body.json(), async function (req, res) {
        const identity = req.body.identity;
        const cancelAtPeriodEnd = req.body.cancel_at_period_end;
        const subscriptionId = req.params.id;

        let member;

        try {
            if (!identity) {
                throw new common.errors.BadRequestError({
                    message: 'Cancel membership failed! Could not find member'
                });
            }

            const claims = await decodeToken(identity);
            const email = claims.sub;
            member = email ? await users.get({email}) : null;

            if (!member) {
                throw new common.errors.BadRequestError({
                    message: 'Cancel membership failed! Could not find member'
                });
            }
        } catch (err) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        // Don't allow removing subscriptions that don't belong to the member
        const subscription = member.stripe.subscriptions.find(sub => sub.id === subscriptionId);

        if (!subscription) {
            res.writeHead(403);
            return res.end('No permission');
        }

        if (subscription.plan.nickname === 'Complimentary') {
            res.writeHead(400);
            return res.end('Bad request');
        }

        if (cancelAtPeriodEnd === undefined) {
            throw new common.errors.BadRequestError({
                message: 'Canceling membership failed!',
                help: 'Request should contain boolean "cancel" field.'
            });
        }

        subscription.cancel_at_period_end = !!(cancelAtPeriodEnd);

        await stripe.updateSubscriptionFromClient(subscription);

        res.writeHead(204);
        res.end();
    });

    const getPublicConfig = function () {
        return Promise.resolve({
            publicKey,
            issuer
        });
    };

    const bus = new (require('events').EventEmitter)();

    if (stripe) {
        stripe.ready().then(() => {
            bus.emit('ready');
        }).catch((err) => {
            bus.emit('error', err);
        });
    } else {
        process.nextTick(() => bus.emit('ready'));
    }

    return {
        middleware,
        getMemberDataFromMagicLinkToken,
        getMemberIdentityToken,
        getMemberIdentityData,
        getPublicConfig,
        bus,
        sendEmailWithMagicLink,
        members: users
    };
};

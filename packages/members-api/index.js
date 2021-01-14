const _ = require('lodash');
const {Router} = require('express');
const body = require('body-parser');
const MagicLink = require('@tryghost/magic-link');
const StripePaymentProcessor = require('./lib/stripe');
const Tokens = require('./lib/tokens');
const Users = require('./lib/users');
const Metadata = require('./lib/metadata');
const common = require('./lib/common');
const {getGeolocationFromIP} = require('./lib/geolocation');

const StripeAPIService = require('./src/services/stripe-api');
const StripePlansService = require('./src/services/stripe-plans');
const StripeWebhookService = require('./src/services/stripe-webhook');
const TokenService = require('./src/services/token');
const MemberRepository = require('./src/repositories/member');

module.exports = function MembersApi({
    tokenConfig: {
        issuer,
        privateKey,
        publicKey
    },
    auth: {
        allowSelfSignup = true,
        getSigninURL,
        tokenProvider
    },
    paymentConfig,
    mail: {
        transporter,
        getText,
        getHTML,
        getSubject
    },
    models: {
        StripeWebhook,
        StripeCustomer,
        StripeCustomerSubscription,
        Member
    },
    logger
}) {
    if (logger) {
        common.logging.setLogger(logger);
    }

    console.log(paymentConfig);

    const stripeAPIService = new StripeAPIService({
        config: {
            secretKey: paymentConfig.stripe.secretKey,
            publicKey: paymentConfig.stripe.publicKey,
            appInfo: paymentConfig.stripe.appInfo,
            enablePromoCodes: paymentConfig.stripe.enablePromoCodes
        },
        logger
    });

    const stripePlansService = new StripePlansService({
        stripeAPIService
    });

    const memberRepository = new MemberRepository({
        stripeAPIService,
        Member,
        StripeCustomer,
        StripeCustomerSubscription
    });

    const stripeWebhookService = new StripeWebhookService({
        StripeWebhook,
        stripeAPIService,
        memberRepository
    });

    const tokenService = new TokenService({privateKey, publicKey, issuer});

    const magicLinkService = new MagicLink({
        transporter,
        tokenProvider,
        getSigninURL,
        getText,
        getHTML,
        getSubject
    });

    const ready = Promise.all([
        stripePlansService.configure({
            product: paymentConfig.stripe.product,
            plans: paymentConfig.stripe.plans
        }),
        stripeWebhookService.configure({
            webhookSecret: process.env.WEBHOOK_SECRET,
            webhook: paymentConfig.stripe.webhook
        })
    ]);

    const {encodeIdentityToken, decodeToken} = Tokens({privateKey, publicKey, issuer});

    async function hasActiveStripeSubscriptions() {
        const firstActiveSubscription = await StripeCustomerSubscription.findOne({
            status: 'active'
        });

        if (firstActiveSubscription) {
            return true;
        }

        const firstTrialingSubscription = await StripeCustomerSubscription.findOne({
            status: 'trialing'
        });

        if (firstTrialingSubscription) {
            return true;
        }

        const firstUnpaidSubscription = await StripeCustomerSubscription.findOne({
            status: 'unpaid'
        });

        if (firstUnpaidSubscription) {
            return true;
        }

        const firstPastDueSubscription = await StripeCustomerSubscription.findOne({
            status: 'past_due'
        });

        if (firstPastDueSubscription) {
            return true;
        }

        return false;
    }

    const users = memberRepository;

    async function sendEmailWithMagicLink({email, requestedType, tokenData, options = {forceEmailType: false}, requestSrc = ''}) {
        let type = requestedType;
        if (!options.forceEmailType) {
            const member = await users.get({email});
            if (member) {
                type = 'signin';
            } else if (type !== 'subscribe') {
                type = 'signup';
            }
        }
        return magicLinkService.sendMagicLink({email, type, requestSrc, tokenData: Object.assign({email}, tokenData)});
    }

    function getMagicLink(email) {
        return magicLinkService.getMagicLink({tokenData: {email}, type: 'signin'});
    }

    async function getMemberDataFromMagicLinkToken(token) {
        const {email, labels = [], name = '', oldEmail} = await magicLinkService.getDataFromToken(token);
        if (!email) {
            return null;
        }

        const member = oldEmail ? await getMemberIdentityData(oldEmail) : await getMemberIdentityData(email);

        if (member) {
            if (oldEmail) {
                // user exists but wants to change their email address
                if (oldEmail) {
                    member.email = email;
                }
                await users.update(member, {id: member.id});
                return getMemberIdentityData(email);
            }
            return member;
        }

        await users.create({name, email, labels});
        return getMemberIdentityData(email);
    }

    async function getMemberIdentityData(email) {
        const model = await users.get({email}, {withRelated: ['stripeSubscriptions', 'stripeSubscriptions.customer']});
        if (!model) {
            return null;
        }
        return model.toJSON();
    }

    async function getMemberIdentityToken(email) {
        const member = await getMemberIdentityData(email);
        if (!member) {
            return null;
        }
        return encodeIdentityToken({sub: member.email});
    }

    async function setMemberGeolocationFromIp(email, ip) {
        if (!email || !ip) {
            throw new common.errors.IncorrectUsageError({
                message: 'setMemberGeolocationFromIp() expects email and ip arguments to be present'
            });
        }

        const member = await users.get({email}, {
            withRelated: ['labels']
        });

        if (!member) {
            throw new common.errors.NotFoundError({
                message: `Member with email address ${email} does not exist`
            });
        }

        // max request time is 500ms so shouldn't slow requests down too much
        let geolocation = JSON.stringify(await getGeolocationFromIP(ip));
        if (geolocation) {
            member.geolocation = geolocation;
            await users.update(member, {id: member.id});
        }

        return getMemberIdentityData(email);
    }

    const middleware = {
        sendMagicLink: Router(),
        createCheckoutSession: Router(),
        createCheckoutSetupSession: Router(),
        handleStripeWebhook: Router(),
        updateSubscription: Router({mergeParams: true})
    };

    middleware.sendMagicLink.use(body.json(), async function (req, res) {
        const {email, emailType, oldEmail, requestSrc} = req.body;
        let forceEmailType = false;
        if (!email) {
            res.writeHead(400);
            return res.end('Bad Request.');
        }

        try {
            if (oldEmail) {
                const existingMember = await users.get({email});
                if (existingMember) {
                    throw new common.errors.BadRequestError({
                        message: 'This email is already associated with a member'
                    });
                }
                forceEmailType = true;
            }

            if (!allowSelfSignup) {
                const member = oldEmail ? await users.get({oldEmail}) : await users.get({email});
                if (member) {
                    const tokenData = _.pick(req.body, ['oldEmail']);
                    await sendEmailWithMagicLink({email, tokenData, requestedType: emailType, requestSrc, options: {forceEmailType}});
                }
            } else {
                const tokenData = _.pick(req.body, ['labels', 'name', 'oldEmail']);
                await sendEmailWithMagicLink({email, tokenData, requestedType: emailType, requestSrc, options: {forceEmailType}});
            }
            res.writeHead(201);
            return res.end('Created.');
        } catch (err) {
            const statusCode = (err && err.statusCode) || 500;
            common.logging.error(err);
            res.writeHead(statusCode);
            return res.end('Internal Server Error.');
        }
    });

    middleware.createCheckoutSession.use(body.json(), async function (req, res) {
        const plan = req.body.plan;
        const identity = req.body.identity;

        if (!plan) {
            res.writeHead(400);
            return res.end('Missing plan');
        }

        // NOTE: never allow "Complimentary" plan to be subscribed to from the client
        if (plan.toLowerCase() === 'complimentary') {
            res.writeHead(400);
            return res.end('Requested complimentary plan');
        }

        let email;
        try {
            if (!identity) {
                email = null;
            } else {
                const claims = await decodeToken(identity);
                email = claims && claims.sub;
            }
        } catch (err) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        const member = email ? await users.get({email}, {withRelated: ['stripeCustomers', 'stripeSubscriptions']}) : null;

        // Do not allow members already with a subscription to initiate a new checkout session
        if (member && member.related('stripeSubscriptions').length > 0) {
            res.writeHead(403);
            return res.end('No permission');
        }

        try {
            const sessionInfo = await stripeAPIService.createCheckoutSession(
                stripePlansService.getPlan(plan),
                {
                    successUrl: req.body.successUrl,
                    cancelUrl: req.body.cancelUrl,
                    customerEmail: req.body.customerEmail,
                    metadata: req.body.metadata
                }
            );

            res.writeHead(200, {
                'Content-Type': 'application/json'
            });

            res.end(JSON.stringify(sessionInfo));
        } catch (e) {
            const error = e.message || 'Unable to initiate checkout session';
            res.writeHead(400);
            return res.end(error);
        }
    });

    middleware.createCheckoutSetupSession.use(body.json(), async function (req, res) {
        const identity = req.body.identity;

        let email;
        try {
            if (!identity) {
                email = null;
            } else {
                const claims = await decodeToken(identity);
                email = claims && claims.sub;
            }
        } catch (err) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        const member = email ? await users.get({email}) : null;

        if (!member) {
            res.writeHead(403);
            return res.end('Bad Request.');
        }

        const sessionInfo = await stripeAPIService.createCheckoutSetupSession(member, {
            successUrl: req.body.successUrl,
            cancelUrl: req.body.cancelUrl
        });

        res.writeHead(200, {
            'Content-Type': 'application/json'
        });

        res.end(JSON.stringify(sessionInfo));
    });

    middleware.handleStripeWebhook.use(body.raw({type: 'application/json'}), async function (req, res) {
        let event;
        try {
            event = stripeWebhookService.parseWebhook(req.body, req.headers['stripe-signature']);
        } catch (err) {
            common.logging.error(err);
            res.writeHead(401);
            return res.end();
        }
        common.logging.info(`Handling webhook ${event.type}`);
        try {
            await stripeWebhookService.handleWebhook(event);
            res.writeHead(200);
            res.end();
        } catch (err) {
            common.logging.error(`Error handling webhook ${event.type}`, err);
            res.writeHead(400);
            res.end();
        }
    });

    middleware.updateSubscription.use(body.json(), async function (req, res) {
        const identity = req.body.identity;
        const subscriptionId = req.params.id;
        const cancelAtPeriodEnd = req.body.cancel_at_period_end;
        const cancellationReason = req.body.cancellation_reason;
        const planName = req.body.planName;

        if (cancelAtPeriodEnd === undefined && planName === undefined) {
            throw new common.errors.BadRequestError({
                message: 'Updating subscription failed!',
                help: 'Request should contain "cancel_at_period_end" or "planName" field.'
            });
        }

        if ((cancelAtPeriodEnd === undefined || cancelAtPeriodEnd === false) && cancellationReason !== undefined) {
            throw new common.errors.BadRequestError({
                message: 'Updating subscription failed!',
                help: '"cancellation_reason" field requires the "cancel_at_period_end" field to be true.'
            });
        }

        if (cancellationReason && cancellationReason.length > 500) {
            throw new common.errors.BadRequestError({
                message: 'Updating subscription failed!',
                help: '"cancellation_reason" field can be a maximum of 500 characters.'
            });
        }

        let email;
        try {
            if (!identity) {
                throw new common.errors.BadRequestError({
                    message: 'Updating subscription failed! Could not find member'
                });
            }

            const claims = await decodeToken(identity);
            email = claims && claims.sub;
        } catch (err) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        const member = email ? await users.get({email}, {withRelated: ['stripeSubscriptions']}) : null;

        if (!member) {
            throw new common.errors.BadRequestError({
                message: 'Updating subscription failed! Could not find member'
            });
        }

        // Don't allow removing subscriptions that don't belong to the member
        const subscription = member.related('stripeSubscriptions').models.find(
            subscription => subscription.get('subscription_id') === subscriptionId
        );
        if (!subscription) {
            res.writeHead(403);
            return res.end('No permission');
        }

        const subscriptionUpdateData = {
            id: subscriptionId
        };
        if (cancelAtPeriodEnd !== undefined) {
            subscriptionUpdateData.cancel_at_period_end = cancelAtPeriodEnd;
            subscriptionUpdateData.cancellation_reason = cancellationReason;
        }

        if (planName !== undefined) {
            const plan = stripe.findPlanByNickname(planName);
            if (!plan) {
                throw new common.errors.BadRequestError({
                    message: 'Updating subscription failed! Could not find plan'
                });
            }
            subscriptionUpdateData.plan = plan.id;
        }

        await stripeAPIService.updateSubscriptionFromClient(subscriptionUpdateData);

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

    ready.then(() => {
        bus.emit('ready');
    }).catch((err) => {
        bus.emit('error', err);
    });

    return {
        middleware,
        getMemberDataFromMagicLinkToken,
        getMemberIdentityToken,
        getMemberIdentityData,
        setMemberGeolocationFromIp,
        getPublicConfig,
        bus,
        sendEmailWithMagicLink,
        getMagicLink,
        hasActiveStripeSubscriptions,
        members: users
    };
};

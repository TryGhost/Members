const common = require('../../../lib/common');
const _ = require('lodash');
const errors = require('ghost-ignition').errors;

/**
 * RouterController
 *
 * @param {object} deps
 * @param {any} deps.memberRepository
 * @param {boolean} deps.allowSelfSignup
 * @param {any} deps.magicLinkService
 * @param {any} deps.stripeAPIService
 * @param {any} deps.stripePlanService
 * @param {any} deps.tokenService
 */
module.exports = class RouterController {
    constructor({
        memberRepository,
        allowSelfSignup,
        magicLinkService,
        stripeAPIService,
        stripePlansService,
        tokenService
    }) {
        this._memberRepository = memberRepository;
        this._allowSelfSignup = allowSelfSignup;
        this._magicLinkService = magicLinkService;
        this._stripeAPIService = stripeAPIService;
        this._stripePlansService = stripePlansService;
        this._tokenService = tokenService;
    }

    ensureStripe() {
        return async (_req, res, next) => {
            if (!this._stripeAPIService) {
                res.writeHead(400);
                return res.end('Stripe not configured');
            }
            try {
                await this._stripeAPIService.ready();
                next();
            } catch (err) {
                res.writeHead(500);
                return res.end('There was an error configuring stripe');
            }
        };
    }

    updateSubscription() {
        return async (req, res) => {
            const identity = req.body.identity;
            const subscriptionId = req.params.id;
            const cancelAtPeriodEnd = req.body.cancel_at_period_end;
            const cancellationReason = req.body.cancellation_reason;
            const planName = req.body.planName;

            if (cancelAtPeriodEnd === undefined && planName === undefined) {
                throw new errors.BadRequestError({
                    message: 'Updating subscription failed!',
                    help: 'Request should contain "cancel_at_period_end" or "planName" field.'
                });
            }

            if ((cancelAtPeriodEnd === undefined || cancelAtPeriodEnd === false) && cancellationReason !== undefined) {
                throw new errors.BadRequestError({
                    message: 'Updating subscription failed!',
                    help: '"cancellation_reason" field requires the "cancel_at_period_end" field to be true.'
                });
            }

            if (cancellationReason && cancellationReason.length > 500) {
                throw new errors.BadRequestError({
                    message: 'Updating subscription failed!',
                    help: '"cancellation_reason" field can be a maximum of 500 characters.'
                });
            }

            let email;
            try {
                if (!identity) {
                    throw new errors.BadRequestError({
                        message: 'Updating subscription failed! Could not find member'
                    });
                }

                const claims = await this._tokenService.decodeToken(identity);
                email = claims && claims.sub;
            } catch (err) {
                res.writeHead(401);
                return res.end('Unauthorized');
            }

            const member = email ? await this._memberRepository.get({ email }, { withRelated: ['stripeSubscriptions'] }) : null;

            if (!member) {
                throw new errors.BadRequestError({
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

            if (planName !== undefined) {
                const plan = this._stripePlansService.getPlans().find(plan => plan.nickname === planName);
                if (!plan) {
                    throw new errors.BadRequestError({
                        message: 'Updating subscription failed! Could not find plan'
                    });
                }
                subscriptionUpdateData.plan = plan.id;
                this._stripeAPIService.changeSubscriptionPlan(subscriptionId, plan.id);
            } else if (cancelAtPeriodEnd !== undefined) {
                if (cancelAtPeriodEnd) {
                    this._stripeAPIService.cancelSubscriptionAtPeriodEnd(
                        subscriptionId, cancellationReason
                    );
                } else {
                    this._stripeAPIService.continueSubscriptionAtPeriodEnd(
                        subscriptionId
                    );
                }
            }

            res.writeHead(204);
            res.end();
        };
    }

    createCheckoutSetupSession() {
        return async (req, res) => {
            const identity = req.body.identity;

            let email;
            try {
                if (!identity) {
                    email = null;
                } else {
                    const claims = await this._tokenService.decodeToken(identity);
                    email = claims && claims.sub;
                }
            } catch (err) {
                res.writeHead(401);
                return res.end('Unauthorized');
            }

            const member = email ? await this._memberRepository.get({ email }) : null;

            if (!member) {
                res.writeHead(403);
                return res.end('Bad Request.');
            }

            const sessionInfo = await this._stripeAPIService.createCheckoutSetupSession(member, {
                successUrl: req.body.successUrl,
                cancelUrl: req.body.cancelUrl
            });

            res.writeHead(200, {
                'Content-Type': 'application/json'
            });

            res.end(JSON.stringify(sessionInfo));
        };
    }

    createCheckoutSession() {
        return async (req, res) => {
            const plan = req.body.plan;
            const identity = req.body.identity;

            if (!plan) {
                res.writeHead(400);
                return res.end('Bad Request.');
            }

            // NOTE: never allow "Complimentary" plan to be subscribed to from the client
            if (plan.toLowerCase() === 'complimentary') {
                res.writeHead(400);
                return res.end('Bad Request.');
            }

            let email;
            try {
                if (!identity) {
                    email = null;
                } else {
                    const claims = await this._tokenService.decodeToken(identity);
                    email = claims && claims.sub;
                }
            } catch (err) {
                res.writeHead(401);
                return res.end('Unauthorized');
            }

            const member = email ? await this._memberRepository.get({ email }, { withRelated: ['stripeSubscriptions'] }) : null;

            // Do not allow members already with a subscription to initiate a new checkout session
            if (member && member.related('stripeSubscriptions').length > 0) {
                res.writeHead(403);
                return res.end('No permission');
            }

            try {
                const sessionInfo = await this._stripeAPIService.createCheckoutSession(member, plan, {
                    successUrl: req.body.successUrl,
                    cancelUrl: req.body.cancelUrl,
                    customerEmail: req.body.customerEmail,
                    metadata: req.body.metadata
                });

                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });

                res.end(JSON.stringify(sessionInfo));
            } catch (e) {
                const error = e.message || 'Unable to initiate checkout session';
                res.writeHead(400);
                return res.end(error);
            }
        };
    }

    sendMagicLink() {
        return async (req, res) => {
            const { email, emailType, oldEmail, requestSrc } = req.body;
            let forceEmailType = false;
            if (!email) {
                res.writeHead(400);
                return res.end('Bad Request.');
            }

            try {
                if (oldEmail) {
                    const existingMember = await this._memberRepository.get({ email });
                    if (existingMember) {
                        throw new errors.BadRequestError({
                            message: 'This email is already associated with a member'
                        });
                    }
                    forceEmailType = true;
                }

                if (!this._allowSelfSignup) {
                    const member = oldEmail ? await this._memberRepository.get({ oldEmail }) : await this._memberRepository.get({ email });
                    if (member) {
                        const tokenData = _.pick(req.body, ['oldEmail']);
                        await this.sendEmailWithMagicLink({ email, tokenData, requestedType: emailType, requestSrc, options: { forceEmailType } });
                    }
                } else {
                    const tokenData = _.pick(req.body, ['labels', 'name', 'oldEmail']);
                    await this.sendEmailWithMagicLink({ email, tokenData, requestedType: emailType, requestSrc, options: { forceEmailType } });
                }
                res.writeHead(201);
                return res.end('Created.');
            } catch (err) {
                const statusCode = (err && err.statusCode) || 500;
                common.logging.error(err);
                res.writeHead(statusCode);
                return res.end('Internal Server Error.');
            }
        };
    },

    async sendEmailWithMagicLink({ email, requestedType, tokenData, options = { forceEmailType: false }, requestSrc = '' }) {
        let type = requestedType;
        if (!options.forceEmailType) {
            const member = await this._memberRepository.get({ email });
            if (member) {
                type = 'signin';
            } else if (type !== 'subscribe') {
                type = 'signup';
            }
        }
        return this._magicLinkService.sendMagicLink({ email, type, requestSrc, tokenData: Object.assign({ email }, tokenData) });
    }

    async sendEmailWithMagicLink({ email, requestedType, tokenData, options = { forceEmailType: false }, requestSrc = '' }) {
        let type = requestedType;
        if (!options.forceEmailType) {
            const member = await this._memberRepository.get({ email });
            if (member) {
                type = 'signin';
            } else if (type !== 'subscribe') {
                type = 'signup';
            }
        }
        return this._magicLinkService.sendMagicLink({ email, type, requestSrc, tokenData: Object.assign({ email }, tokenData) });
    }
};
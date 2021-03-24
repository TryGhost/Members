const errors = require('ghost-ignition').errors;

/**
 * MemberController
 *
 * @param {object} deps
 * @param {any} deps.memberRepository
 * @param {any} deps.stripeAPIService
 * @param {any} deps.stripePlansService
 * @param {any} deps.tokenService
 */
module.exports = class MemberController {
    constructor({
        memberRepository,
        stripeAPIService,
        stripePlansService,
        tokenService
    }) {
        this._memberRepository = memberRepository;
        this._stripeAPIService = stripeAPIService;
        this._stripePlansService = stripePlansService;
        this._tokenService = tokenService;
    }

    async updateSubscription(req, res) {
        try {
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

            const member = email ? await this._memberRepository.get({email}, {withRelated: ['stripeSubscriptions']}) : null;

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

            let updatedSubscription;
            if (planName !== undefined) {
                const plan = this._stripePlansService.getPlans().find(plan => plan.nickname === planName);
                if (!plan) {
                    throw new errors.BadRequestError({
                        message: 'Updating subscription failed! Could not find plan'
                    });
                }
                updatedSubscription = await this._stripeAPIService.changeSubscriptionPlan(subscriptionId, plan.id);
            } else if (cancelAtPeriodEnd !== undefined) {
                if (cancelAtPeriodEnd) {
                    updatedSubscription = await this._stripeAPIService.cancelSubscriptionAtPeriodEnd(
                        subscriptionId, cancellationReason
                    );
                } else {
                    updatedSubscription = await this._stripeAPIService.continueSubscriptionAtPeriodEnd(
                        subscriptionId
                    );
                }
            }
            if (updatedSubscription) {
                await this._memberRepository.linkSubscription({
                    id: member.id,
                    subscription: updatedSubscription
                });
            }

            res.writeHead(204);
            res.end();
        } catch (err) {
            res.writeHead(err.statusCode || 500);
            res.end(err.message);
        }
    }
};

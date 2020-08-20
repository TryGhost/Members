const _ = require('lodash');
const uuid = require('uuid');
const ObjectId = require('bson-objectid');
const moment = require('moment-timezone');
const errors = require('@tryghost/errors');
const membersService = require('../index');
const bulkOperations = require('./bulk-operations');
const models = require('../../../models');
const {i18n} = require('../../../lib/common');
const logging = require('../../../../shared/logging');

const doImport = async ({members, allLabelModels, importSetLabels, createdBy}) => {
    const createInserter = table => data => bulkOperations.insert(table, data);
    const createDeleter = table => data => bulkOperations.del(table, data);

    const deleteMembers = createDeleter('members');
    const insertLabelAssociations = createInserter('members_labels');

    let {
        invalidMembers,
        membersToInsert,
        stripeCustomersToFetch,
        stripeCustomersToCreate,
        labelAssociationsToInsert
    } = getMemberData({members, allLabelModels, importSetLabels, createdBy});

    // NOTE: member insertion has to happen before the rest of insertions to handle validation
    //       errors - remove failed members from label/stripe sets
    const insertedMembers = await models.Member.bulkAdd(membersToInsert).then((insertResult) => {
        if (insertResult.unsuccessfulIds.length) {
            labelAssociationsToInsert = labelAssociationsToInsert
                .filter(la => !insertResult.unsuccessfulIds.includes(la.member_id));

            stripeCustomersToFetch = stripeCustomersToFetch
                .filter(sc => !insertResult.unsuccessfulIds.includes(sc.member_id));

            stripeCustomersToCreate = stripeCustomersToCreate
                .filter(sc => !insertResult.unsuccessfulIds.includes(sc.member_id));
        }

        return insertResult;
    });

    const fetchedStripeCustomersPromise = fetchStripeCustomers(stripeCustomersToFetch);
    const createdStripeCustomersPromise = createStripeCustomers(stripeCustomersToCreate);
    const insertedLabelsPromise = insertLabelAssociations(labelAssociationsToInsert);

    const insertedCustomersPromise = Promise.all([
        fetchedStripeCustomersPromise,
        createdStripeCustomersPromise
    ]).then(
        ([fetchedStripeCustomers, createdStripeCustomers]) => {
            return models.MemberStripeCustomer.bulkAdd(
                fetchedStripeCustomers.customersToInsert.concat(createdStripeCustomers.customersToInsert)
            );
        }
    );

    const insertedSubscriptionsPromise = Promise.all([
        fetchedStripeCustomersPromise,
        createdStripeCustomersPromise,
        insertedCustomersPromise
    ]).then(
        ([fetchedStripeCustomers, createdStripeCustomers]) => models.StripeCustomerSubscription.bulkAdd(
            fetchedStripeCustomers.subscriptionsToInsert.concat(createdStripeCustomers.subscriptionsToInsert)
        )
    );

    const deletedMembersPromise = Promise.all([
        fetchedStripeCustomersPromise,
        createdStripeCustomersPromise
    ]).then(
        ([fetchedStripeCustomers, createdStripeCustomers]) => deleteMembers(
            fetchedStripeCustomers.membersToDelete.concat(createdStripeCustomers.membersToDelete)
        )
    );

    // This looks sequential, but at the point insertedCustomersPromise has resolved so have all the others
    const insertedSubscriptions = await insertedSubscriptionsPromise;
    const insertedCustomers = await insertedCustomersPromise;
    const deletedMembers = await deletedMembersPromise;
    const fetchedCustomers = await fetchedStripeCustomersPromise;
    const insertedLabels = await insertedLabelsPromise;

    const result = {
        imported: {
            count: insertedMembers.successful - deletedMembers.successful
        },
        invalid: {
            count: insertedMembers.unsuccessful + deletedMembers.unsuccessful + invalidMembers.length,
            errors: [
                ...insertedMembers.errors,
                ...insertedCustomers.errors,
                ...insertedSubscriptions.errors,
                ...insertedLabels.errors,
                ...fetchedCustomers.errors
            ]
        }
    };

    // Allow logging to happen outside of the request cycle
    process.nextTick(() => {
        // @TODO wrap errors with validation errors (or whatever is reasonable)
        result.invalid.errors.forEach(err => logging.error(err));
    });

    return result;
};

function serializeMemberLabels(labels) {
    return labels.reduce((labelsAcc, label) => {
        if (!label) {
            return labels;
        }
        if (typeof label !== 'string') {
            return labelsAcc.concat(label.name);
        }
        return labelsAcc.concat(label.trim());
    }, []);
}

function getMemberData({members, allLabelModels, importSetLabels, createdBy}) {
    const labelIdLookup = allLabelModels.reduce(function (labelIdLookupAcc, labelModel) {
        return Object.assign(labelIdLookupAcc, {
            [labelModel.get('name')]: labelModel.id
        });
    }, {});

    const importedLabels = importSetLabels.map(label => label.name);

    const invalidMembers = [];
    const membersToInsert = [];
    const stripeCustomersToFetch = [];
    const stripeCustomersToCreate = [];
    const labelAssociationsToInsert = [];

    members.forEach(function (member) {
        // @TODO This is expensive, maybe we can just error if we get shoddy data?
        for (let key in member) {
            if (member[key] === 'undefined') {
                delete member[key];
            }
        }

        let subscribed;
        if (_.isUndefined(member.subscribed_to_emails)) {
            // Member's model default
            subscribed = true;
        } else {
            subscribed = (String(member.subscribed_to_emails).toLowerCase() !== 'false');
        }

        let createdAt = member.created_at === '' ? undefined : member.created_at;

        if (createdAt) {
            const date = new Date(createdAt);

            // CASE: client sends `0000-00-00 00:00:00`
            if (isNaN(date)) {
                // TODO: throw in validation stage for single record, not whole batch!
                throw new errors.ValidationError({
                    message: i18n.t('errors.models.base.invalidDate', {key: 'created_at'}),
                    code: 'DATE_INVALID'
                });
            }

            createdAt = moment(createdAt).toDate();
        } else {
            createdAt = new Date();
        }

        const memberToInsert = {
            id: ObjectId.generate(),
            uuid: uuid.v4(), // member model default
            email: member.email,
            name: member.name,
            note: member.note,
            subscribed: subscribed,
            created_at: createdAt,
            created_by: createdBy
        };
        membersToInsert.push(memberToInsert);

        const memberLabels = member.labels
            ? serializeMemberLabels((member.labels || '').split(','))
            : [];
        const allLabels = _.union(memberLabels, importedLabels);

        const memberLabelAssociationsToInsert = allLabels.map((label, index) => {
            return {
                id: ObjectId.generate(),
                member_id: memberToInsert.id,
                label_id: labelIdLookup[label],
                sort_order: index
            };
        });
        labelAssociationsToInsert.push(...memberLabelAssociationsToInsert);

        if (member.stripe_customer_id) {
            const stripeCustomerToFetch = {
                customer_id: member.stripe_customer_id,
                member_id: memberToInsert.id
            };
            stripeCustomersToFetch.push(stripeCustomerToFetch);
        }

        if (String(member.complimentary_plan).toLowerCase() === 'true') {
            const stripeCustomerToCreate = {
                member_id: memberToInsert.id,
                name: memberToInsert.name,
                email: memberToInsert.email
            };
            stripeCustomersToCreate.push(stripeCustomerToCreate);
        }
    });

    return {
        invalidMembers,
        membersToInsert,
        stripeCustomersToFetch,
        stripeCustomersToCreate,
        labelAssociationsToInsert
    };
}

async function createStripeCustomers(stripeCustomersToCreate) {
    const result = {
        errors: [],
        customersToInsert: [],
        subscriptionsToInsert: [],
        membersToDelete: []
    };

    await Promise.all(stripeCustomersToCreate.map(async function createStripeCustomer(customerToCreate) {
        try {
            const customer = await membersService.api.members.createStripeCustomer({
                email: customerToCreate.email,
                name: customerToCreate.name
            });

            result.customersToInsert.push({
                id: ObjectId.generate(),
                member_id: customerToCreate.member_id,
                customer_id: customer.id,
                email: customer.email,
                name: customer.name,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: 1,
                updated_by: 1
            });

            const subscription = await membersService.api.members.createComplimentarySubscription(customer);

            const payment = subscription.default_payment_method;
            result.subscriptionsToInsert.push({
                id: ObjectId.generate(),
                customer_id: customer.id,
                subscription_id: subscription.id,
                plan_id: subscription.plan.id,
                status: subscription.status,
                cancel_at_period_end: subscription.cancel_at_period_end,
                current_period_end: new Date(subscription.current_period_end * 1000),
                start_date: new Date(subscription.start_date * 1000),
                default_payment_card_last4: payment && payment.card && payment.card.last4 || null,
                plan_nickname: subscription.plan.nickname || '',
                plan_interval: subscription.plan.interval,
                plan_amount: subscription.plan.amount,
                plan_currency: subscription.plan.currency,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: 1,
                updated_by: 1
            });
        } catch (error) {
            if (error.message.indexOf('customer') && error.code === 'resource_missing') {
                error.message = `Member not imported. ${error.message}`;
                error.context = i18n.t('errors.api.members.stripeCustomerNotFound.context');
                error.help = i18n.t('errors.api.members.stripeCustomerNotFound.help');
            }
            result.errors.push(error);
            result.membersToDelete.push(customerToCreate.member_id);
        }
    }));

    return result;
}

async function fetchStripeCustomers(stripeCustomersToInsert) {
    const result = {
        errors: [],
        customersToInsert: [],
        subscriptionsToInsert: [],
        membersToDelete: []
    };

    await Promise.all(stripeCustomersToInsert.map(async function fetchStripeCustomer(customer) {
        try {
            const fetchedCustomer = await membersService.api.members.getStripeCustomer(customer.customer_id, {
                expand: ['subscriptions', 'subscriptions.data.default_payment_method']
            });

            result.customersToInsert.push({
                id: ObjectId.generate(),
                member_id: customer.member_id,
                customer_id: customer.customer_id,
                email: fetchedCustomer.email,
                name: fetchedCustomer.name,
                created_at: new Date(),
                updated_at: new Date(),
                created_by: 1,
                updated_by: 1
            });

            fetchedCustomer.subscriptions.data.forEach((subscription) => {
                const payment = subscription.default_payment_method;
                result.subscriptionsToInsert.push({
                    id: ObjectId.generate(),
                    customer_id: customer.customer_id,
                    subscription_id: subscription.id,
                    plan_id: subscription.plan.id,
                    status: subscription.status,
                    cancel_at_period_end: subscription.cancel_at_period_end,
                    current_period_end: new Date(subscription.current_period_end * 1000),
                    start_date: new Date(subscription.start_date * 1000),
                    default_payment_card_last4: payment && payment.card && payment.card.last4 || null,
                    plan_nickname: subscription.plan.nickname || '',
                    plan_interval: subscription.plan.interval,
                    plan_amount: subscription.plan.amount,
                    plan_currency: subscription.plan.currency,
                    created_at: new Date(),
                    updated_at: new Date(),
                    created_by: 1,
                    updated_by: 1
                });
            });
        } catch (error) {
            if (error.message.indexOf('customer') && error.code === 'resource_missing') {
                error.message = `Member not imported. ${error.message}`;
                error.context = i18n.t('errors.api.members.stripeCustomerNotFound.context');
                error.help = i18n.t('errors.api.members.stripeCustomerNotFound.help');
            }
            result.errors.push(error);
            result.membersToDelete.push(customer.member_id);
        }
    }));

    return result;
}

module.exports = doImport;

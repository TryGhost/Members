const should = require('should');
const EventRepository = require('../../../../lib/repositories/event');
const sinon = require('sinon');
const errors = require('@tryghost/errors');

process.env.database__client = 'sqlite3';
process.env.database__connection__filename = ':memory:';

const models = require('ghost/core/server/models');
const schema = require('ghost/core/server/data/schema');

describe('EventRepository', function () {
    describe('validateAndParseEventTimelineFilter', function () {
        let eventRepository;

        before(async function () {
            await models.init();
            for (const table of Object.keys(schema.tables)) {
                await schema.commands.createTable(table);
            }
            eventRepository = new EventRepository({
                EmailRecipient: models.EmailRecipient,
                MemberSubscribeEvent: models.MemberSubscribeEvent,
                MemberPaymentEvent: models.MemberPaymentEvent,
                MemberStatusEvent: models.MemberStatusEvent,
                MemberLoginEvent: models.MemberLoginEvent,
                MemberPaidSubscriptionEvent: models.MemberPaidSubscriptionEvent,
                labsService: null
            });
        });

        after(function () {
            require('ghost/core/server/data/db/connection').destroy();
        });

        it('Can fetch a single event', async function () {
            const member = await models.Member.add({email: 'testing@member.com'});
            const res = await models.MemberLoginEvent.add({member_id: member.id});
            console.log(res);
        });

        it('throws when processing a filter with parenthesis', function () {
            should.throws(() => {
                eventRepository.validateAndParseEventTimelineFilter('(type:1)');
            }, errors.IncorrectUsageError);
            should.throws(() => {
                eventRepository.validateAndParseEventTimelineFilter('type:1+(data.created_at:1+data.member_id:1)');
            }, errors.IncorrectUsageError);
        });

        it('throws when using properties that aren\'t in the allowlist', function () {
            should.throws(() => {
                eventRepository.validateAndParseEventTimelineFilter('(types:1)');
            }, errors.IncorrectUsageError);
        });

        it('throws when using an OR', function () {
            should.throws(() => {
                eventRepository.validateAndParseEventTimelineFilter('type:1,data.created_at:1');
            }, errors.IncorrectUsageError);

            should.throws(() => {
                eventRepository.validateAndParseEventTimelineFilter('type:1+data.created_at:1,data.member_id:1');
            }, errors.IncorrectUsageError);

            should.throws(() => {
                eventRepository.validateAndParseEventTimelineFilter('type:1,data.created_at:1+data.member_id:1');
            }, errors.IncorrectUsageError);
        });

        it('passes when using it correctly with one filter', function () {
            const res = eventRepository.validateAndParseEventTimelineFilter('type:email_delivered_event');
            res.should.be.an.Object();
            res.should.deepEqual({
                type: 'type:email_delivered_event'
            });
        });

        it('passes when using it correctly with multiple filters', function () {
            const res = eventRepository.validateAndParseEventTimelineFilter('type:-[email_delivered_event,email_opened_event,email_failed_event]+data.created_at:<0+data.member_id:123');
            res.should.be.an.Object();
            res.should.deepEqual({
                'data.created_at': 'data.created_at:<0',
                'data.member_id': 'data.member_id:123',
                type: 'type:-[email_delivered_event,email_opened_event,email_failed_event]'
            });
        });

        it('passes when using it correctly with multiple filters used several times', function () {
            const res = eventRepository.validateAndParseEventTimelineFilter('type:-email_delivered_event+data.created_at:<0+data.member_id:123+type:-[email_opened_event,email_failed_event]+data.created_at:>10');
            res.should.be.an.Object();
            res.should.deepEqual({
                'data.created_at': 'data.created_at:<0+data.created_at:>10',
                'data.member_id': 'data.member_id:123',
                type: 'type:-email_delivered_event+type:-[email_opened_event,email_failed_event]'
            });
        });
    });

    describe('getNewsletterSubscriptionEvents', function () {
        let eventRepository;
        let fake;

        before(function () {
            fake = sinon.fake.returns({data: [{toJSON: () => {}}]});
            eventRepository = new EventRepository({
                EmailRecipient: null,
                MemberSubscribeEvent: {
                    findPage: fake
                },
                MemberPaymentEvent: null,
                MemberStatusEvent: null,
                MemberLoginEvent: null,
                MemberPaidSubscriptionEvent: null,
                labsService: null
            });
        });

        afterEach(function () {
            fake.resetHistory();
        });

        it('Passes the filters to the model layer', async function () {
            await eventRepository.getNewsletterSubscriptionEvents({
                filter: 'member_id:123'
            });
            fake.args[0][0].withRelated.should.deepEqual(['member']);
            fake.args[0][0].filter.should.equal('member_id:123');
        });
    });

    describe('getEmailFailedEvents', function () {
        let eventRepository;
        let fake;

        before(function () {
            fake = sinon.fake.returns({data: [{get: () => {}, related: () => ({toJSON: () => {}})}]});
            eventRepository = new EventRepository({
                EmailRecipient: {
                    findPage: fake
                },
                MemberSubscribeEvent: null,
                MemberPaymentEvent: null,
                MemberStatusEvent: null,
                MemberLoginEvent: null,
                MemberPaidSubscriptionEvent: null,
                labsService: null
            });
        });

        afterEach(function () {
            fake.resetHistory();
        });

        it('works when setting no filters', async function () {
            await eventRepository.getEmailFailedEvents({
                order: 'created_at desc'
            });
            fake.args[0][0].withRelated.should.deepEqual(['member', 'email']);
            fake.args[0][0].filter.should.equal('failed_at:-null');
            fake.args[0][0].order.should.equal('failed_at desc');
        });
    });
});

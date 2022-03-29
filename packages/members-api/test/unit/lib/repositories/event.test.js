const should = require('should');
const EventRepository = require('../../../../lib/repositories/event');
const sinon = require('sinon');
const errors = require('@tryghost/errors');
const moment = require('moment');

describe('EventRepository', function () {
    describe('getNQLSubset', function () {
        let eventRepository;

        before(function () {
            eventRepository = new EventRepository({
                EmailRecipient: null,
                Member: null,
                MemberSubscribeEvent: null,
                MemberPaymentEvent: null,
                MemberStatusEvent: null,
                MemberLoginEvent: null,
                MemberPaidSubscriptionEvent: null,
                labsService: null
            });
        });

        it('throws when processing a filter with parenthesis', function () {
            should.throws(() => {
                eventRepository.getNQLSubset('(type:1)');
            }, errors.IncorrectUsageError);
            should.throws(() => {
                eventRepository.getNQLSubset('type:1+(data.created_at:1+data.member_id:1)');
            }, errors.IncorrectUsageError);
        });

        it('throws when using properties that aren\'t in the allowlist', function () {
            should.throws(() => {
                eventRepository.getNQLSubset('(types:1)');
            }, errors.IncorrectUsageError);
        });

        it('throws when using an OR', function () {
            should.throws(() => {
                eventRepository.getNQLSubset('type:1,data.created_at:1');
            }, errors.IncorrectUsageError);

            should.throws(() => {
                eventRepository.getNQLSubset('type:1+data.created_at:1,data.member_id:1');
            }, errors.IncorrectUsageError);

            should.throws(() => {
                eventRepository.getNQLSubset('type:1,data.created_at:1+data.member_id:1');
            }, errors.IncorrectUsageError);
        });

        it('passes when using it correctly with one filter', function () {
            const res = eventRepository.getNQLSubset('type:email_delivered_event');
            res.should.be.an.Object();
            res.should.deepEqual({
                type: 'type:email_delivered_event'
            });
        });

        it('passes when using it correctly with multiple filters', function () {
            const res = eventRepository.getNQLSubset('type:-[email_delivered_event,email_opened_event,email_failed_event]+data.created_at:<0+data.member_id:123');
            res.should.be.an.Object();
            res.should.deepEqual({
                'data.created_at': 'data.created_at:<0',
                'data.member_id': 'data.member_id:123',
                type: 'type:-[email_delivered_event,email_opened_event,email_failed_event]'
            });
        });

        it('passes when using it correctly with multiple filters used several times', function () {
            const res = eventRepository.getNQLSubset('type:-email_delivered_event+data.created_at:<0+data.member_id:123+type:-[email_opened_event,email_failed_event]+data.created_at:>10');
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
                Member: null,
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
            await eventRepository.getNewsletterSubscriptionEvents({
                filter: 'no used'
            }, {
                type: 'unused'
            });
            fake.calledOnceWithExactly({
                withRelated: ['member'],
                filter: ''
            }).should.be.eql(true);
        });

        it('works when setting a created_at filter', async function () {
            await eventRepository.getNewsletterSubscriptionEvents({}, {
                'data.created_at': 'data.created_at:123'
            });
            fake.calledOnceWithExactly({
                withRelated: ['member'],
                filter: 'created_at:123'
            }).should.be.eql(true);
        });

        it('works when setting a combination of filters', async function () {
            await eventRepository.getNewsletterSubscriptionEvents({}, {
                'data.created_at': 'data.created_at:123+data.created_at:<99999',
                'data.member_id': 'data.member_id:-[3,4,5]+data.member_id:-[1,2,3]'
            });
            fake.calledOnceWithExactly({
                withRelated: ['member'],
                filter: 'created_at:123+created_at:<99999+member_id:-[3,4,5]+member_id:-[1,2,3]'
            }).should.be.eql(true);
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
                Member: null,
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
                filter: 'no used',
                order: 'created_at desc'
            }, {
                type: 'unused'
            });
            fake.calledOnceWithExactly({
                withRelated: ['member', 'email'],
                filter: 'failed_at:-null',
                order: 'failed_at desc'
            }).should.be.eql(true);
        });

        it('works when setting a created_at filter', async function () {
            await eventRepository.getEmailDeliveredEvents({
                order: 'created_at desc'
            }, {
                'data.created_at': 'data.created_at:123'
            });
            fake.calledOnceWithExactly({
                withRelated: ['member', 'email'],
                filter: 'delivered_at:-null+delivered_at:123',
                order: 'delivered_at desc'
            }).should.be.eql(true);
        });

        it('works when setting a combination of filters', async function () {
            await eventRepository.getEmailOpenedEvents({
                order: 'created_at desc'
            }, {
                'data.created_at': 'data.created_at:123+data.created_at:<99999',
                'data.member_id': 'data.member_id:-[3,4,5]+data.member_id:-[1,2,3]'
            });
            fake.calledOnceWithExactly({
                withRelated: ['member', 'email'],
                filter: 'opened_at:-null+opened_at:123+opened_at:<99999+member_id:-[3,4,5]+member_id:-[1,2,3]',
                order: 'opened_at desc'
            }).should.be.eql(true);
        });
    });

    describe('getStatuses', function () {
        let eventRepository;
        let fakeStatuses;
        let fakeTotal;

        const currentCounts = {paid: 0, free: 0, comped: 0};
        /**
         * @type {any[]}
         */
        const events = [];
        const today = '2000-01-10';
        const tomorrow = '2000-01-11';
        const yesterday = '2000-01-09';

        before(function () {
            sinon.stub(moment.fn, 'format').returns(today);

            fakeStatuses = sinon.fake.returns({
                toJSON: () => {
                    return events;
                }
            });

            fakeTotal = sinon.fake.returns({
                toJSON: () => {
                    return [
                        {
                            status: 'paid',
                            count: currentCounts.paid
                        },
                        {
                            status: 'free',
                            count: currentCounts.free
                        },
                        {
                            status: 'comped',
                            count: currentCounts.comped
                        }
                    ];
                }
            });

            eventRepository = new EventRepository({
                EmailRecipient: null,
                Member: {
                    findAll: fakeTotal
                },
                MemberSubscribeEvent: null,
                MemberPaymentEvent: null,
                MemberStatusEvent: {
                    findAll: fakeStatuses
                },
                MemberLoginEvent: null,
                MemberPaidSubscriptionEvent: null,
                labsService: null
            });
        });

        afterEach(function () {
            fakeStatuses.resetHistory();
            fakeTotal.resetHistory();
        });

        it('works when there are not status events', async function () {
            events.splice(0, events.length);
            currentCounts.paid = 1;
            currentCounts.free = 2;
            currentCounts.comped = 3;

            const results = await eventRepository.getStatuses();
            results.length.should.eql(1);
            results[0].should.eql({
                date: today,
                paid: 1,
                free: 2,
                comped: 3,
                paid_subscribed: 0,
                paid_canceled: 0
            });

            fakeStatuses.calledOnce.should.eql(true);
            fakeTotal.calledOnce.should.eql(true);
        });

        it('passes paid_subscribers and paid_canceled', async function () {
            events.splice(0, events.length, {
                date: today,
                paid_subscribed: 4,
                paid_canceled: 3,
                free_delta: 2,
                comped_delta: 3
            });
            currentCounts.paid = 1;
            currentCounts.free = 2;
            currentCounts.comped = 3;

            const results = await eventRepository.getStatuses();
            results.length.should.eql(1);
            results[0].should.eql({
                date: today,
                paid: 1,
                free: 2,
                comped: 3,
                paid_subscribed: 4,
                paid_canceled: 3
            });

            fakeStatuses.calledOnce.should.eql(true);
            fakeTotal.calledOnce.should.eql(true);
        });

        it('correctly resolves deltas', async function () {
            events.splice(0, events.length, {
                date: yesterday,
                paid_subscribed: 0,
                paid_canceled: 0,
                free_delta: 0,
                comped_delta: 0
            }, {
                date: today,
                paid_subscribed: 4,
                paid_canceled: 3,
                free_delta: 2,
                comped_delta: 3
            });
            currentCounts.paid = 1;
            currentCounts.free = 2;
            currentCounts.comped = 3;

            const results = await eventRepository.getStatuses();
            results.should.eql([
                {
                    date: yesterday,
                    paid: 0,
                    free: 0,
                    comped: 0,
                    paid_subscribed: 0,
                    paid_canceled: 0
                },
                {
                    date: today,
                    paid: 1,
                    free: 2,
                    comped: 3,
                    paid_subscribed: 4,
                    paid_canceled: 3
                }
            ]);
            fakeStatuses.calledOnce.should.eql(true);
            fakeTotal.calledOnce.should.eql(true);
        });

        it('ignores events in the future', async function () {
            events.splice(0, events.length, {
                date: yesterday,
                paid_subscribed: 0,
                paid_canceled: 0,
                free_delta: 0,
                comped_delta: 0
            }, {
                date: today,
                paid_subscribed: 4,
                paid_canceled: 3,
                free_delta: 2,
                comped_delta: 3
            }, {
                date: tomorrow,
                paid_subscribed: 10,
                paid_canceled: 5,
                free_delta: 8,
                comped_delta: 9
            });
            currentCounts.paid = 1;
            currentCounts.free = 2;
            currentCounts.comped = 3;

            const results = await eventRepository.getStatuses();
            results.should.eql([
                {
                    date: yesterday,
                    paid: 0,
                    free: 0,
                    comped: 0,
                    paid_subscribed: 0,
                    paid_canceled: 0
                },
                {
                    date: today,
                    paid: 1,
                    free: 2,
                    comped: 3,
                    paid_subscribed: 4,
                    paid_canceled: 3
                }
            ]);
            fakeStatuses.calledOnce.should.eql(true);
            fakeTotal.calledOnce.should.eql(true);
        });
    });
});

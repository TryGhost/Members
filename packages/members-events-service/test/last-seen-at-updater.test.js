// Switch these lines once there are useful utils
// const testUtils = require('./utils');
require('./utils');

const assert = require('assert');
const sinon = require('sinon');
const {LastSeenAtUpdater} = require('../');
const DomainEvents = require('@tryghost/domain-events');
const {MemberPageViewEvent} = require('@tryghost/member-events');
const moment = require('moment');

describe('LastSeenAtUpdater', function () {
    it('Calls updateLastSeenAt on MemberPageViewEvents', async function () {
        const now = moment('2022-02-28T18:00:00Z').utc();
        const previousLastSeen = moment('2022-02-27T23:00:00Z').toISOString();
        const stub = sinon.stub().resolves();
        const settingsCache = sinon.stub().returns('Etc/UTC');
        const domainEvents = new DomainEvents();
        const updater = new LastSeenAtUpdater({
            services: {
                settingsCache: {
                    get: settingsCache
                },
                domainEvents
            },
            async getMembersApi() {
                return {
                    members: {
                        update: stub
                    }
                };
            }
        });
        sinon.stub(updater, 'updateLastSeenAt');
        domainEvents.dispatch(MemberPageViewEvent.create({memberId: '1', memberLastSeenAt: previousLastSeen, url: '/'}, now.toDate()));
        assert(updater.updateLastSeenAt.calledOnceWithExactly('1', previousLastSeen, now.toDate()));
    });

    it('works correctly on another timezone (not updating last_seen_at)', async function () {
        const now = moment('2022-02-28T04:00:00Z').utc();
        const previousLastSeen = moment('2022-02-27T20:00:00Z').toISOString();
        const stub = sinon.stub().resolves();
        const settingsCache = sinon.stub().returns('Asia/Bangkok');
        const domainEvents = new DomainEvents();
        const updater = new LastSeenAtUpdater({
            services: {
                settingsCache: {
                    get: settingsCache
                },
                domainEvents
            },
            async getMembersApi() {
                return {
                    members: {
                        update: stub
                    }
                };
            }
        });
        await updater.updateLastSeenAt('1', previousLastSeen, now.toDate());
        assert(stub.notCalled, 'The LastSeenAtUpdater should attempt a member update when the new timestamp is within the same day in the publication timezone.');
    });

    it('works correctly on another timezone (updating last_seen_at)', async function () {
        const now = moment('2022-02-28T04:00:00Z').utc();
        const previousLastSeen = moment('2022-02-27T20:00:00Z').toISOString();
        const stub = sinon.stub().resolves();
        const settingsCache = sinon.stub().returns('Europe/Paris');
        const domainEvents = new DomainEvents();
        const updater = new LastSeenAtUpdater({
            services: {
                settingsCache: {
                    get: settingsCache
                },
                domainEvents
            },
            async getMembersApi() {
                return {
                    members: {
                        update: stub
                    }
                };
            }
        });
        await updater.updateLastSeenAt('1', previousLastSeen, now.toDate());
        assert(stub.calledOnceWithExactly({
            last_seen_at: now.format('YYYY-MM-DD HH:mm:ss')
        }, {
            id: '1'
        }), 'The LastSeenAtUpdater should attempt a member update with the current date.');
    });

    it('Doesn\'t update when last_seen_at is too recent', async function () {
        const now = moment('2022-02-28T18:00:00Z');
        const previousLastSeen = moment('2022-02-28T00:00:00Z').toISOString();
        const stub = sinon.stub().resolves();
        const settingsCache = sinon.stub().returns('Etc/UTC');
        const domainEvents = new DomainEvents();
        const updater = new LastSeenAtUpdater({
            services: {
                settingsCache: {
                    get: settingsCache
                },
                domainEvents: DomainEvents
            },
            async getMembersApi() {
                return {
                    members: {
                        update: stub
                    }
                };
            }
        });
        await updater.updateLastSeenAt('1', previousLastSeen, now.toDate());
        assert(stub.notCalled, 'The LastSeenAtUpdater should\'t update a member when the previous last_seen_at is close to the event timestamp.');
    });

    it('Doesn\'t fire on other events', async function () {
        const now = moment('2022-02-28T18:00:00Z');
        const stub = sinon.stub().resolves();
        const settingsCache = sinon.stub().returns('Etc/UTC');
        const domainEvents = new DomainEvents();
        const updater = new LastSeenAtUpdater({
            services: {
                settingsCache: {
                    get: settingsCache
                },
                domainEvents
            },
            async getMembersApi() {
                return {
                    members: {
                        update: stub
                    }
                };
            }
        });
        await updater.updateLastSeenAt('1', undefined, now.toDate());
        assert(stub.notCalled, 'The LastSeenAtUpdater should never fire on MemberPageViewEvent events.');
    });
});

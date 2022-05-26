const DomainEvents = require('@tryghost/domain-events');
const MemberRepository = require('../../../../lib/repositories/member');

describe('MemberRepository', function () {
    describe('#isComplimentarySubscription', function () {
        it('Does not error when subscription.plan is null', function () {
            const repo = new MemberRepository({
                domainEvents: new DomainEvents()
            });
            repo.isComplimentarySubscription({});
        });
    });
});

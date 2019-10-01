const hash = str => require('crypto').createHash('sha256').update(str).digest('base64');

module.exports = function ({
    sendEmailWithMagicLink,
    stripe,
    createMember,
    getMember,
    updateMember,
    listMembers,
    deleteMember
}) {
    async function get(data, options) {
        const member = await getMember(data, options);
        if (!member) {
            return member;
        }

        if (!stripe) {
            return Object.assign(member, {
                public_id: hash(member.id),
                stripe: {
                    subscriptions: []
                }
            });
        }
        try {
            const subscriptions = await stripe.getActiveSubscriptions(member);

            return Object.assign(member, {
                public_id: hash(member.id),
                stripe: {
                    subscriptions
                }
            });
        } catch (err) {
            console.log(err);
            return null;
        }
    }

    async function destroy(data, options) {
        const member = await getMember(data, options);
        if (!member) {
            return;
        }
        if (stripe) {
            await stripe.removeCustomer(member);
        }
        return deleteMember(data, options);
    }

    async function update(data, options) {
        return updateMember(data, options);
    }

    async function list(options) {
        return listMembers(options);
    }

    async function create(data, options) {
        const member = await createMember(data);
        if (options.sendEmail) {
            await sendEmailWithMagicLink(member.email, options.emailType);
        }
        return member;
    }

    return {
        create,
        update,
        list,
        get,
        destroy
    };
};

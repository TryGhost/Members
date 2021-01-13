const MagicLink = require('@tryghost/magic-link');

module.exports = class MagicLinkService {
    /**
     * @param {object} params
     * @param {object} params.config
     * @param {any} params.config.transporter
     * @param {any} params.config.tokenProvider
     * @param {any} params.config.getSigninURL
     * @param {any} params.config.getText
     * @param {any} params.config.getHTML
     * @param {any} params.config.getSubject
     * @param {any} params.MemberRepository
     */
    constructor({
        config,
        MemberRepository
    }) {
        this._magicLinkService = new MagicLink({
            transporter: config.transporter,
            tokenProvider: config.tokenProvider,
            getSigninURL: config.getSigninURL,
            getText: config.getText,
            getHTML: config.getHTML,
            getSubject: config.getSubject
        });
        this._MemberRepository = MemberRepository;
    }

    async sendEmailWithMagicLink({email, requestedType, tokenData, options = {forceEmailType: false}, requestSrc = ''}) {
        let type = requestedType;
        if (!options.forceEmailType) {
            const member = await this._MemberRepository.get({email});
            if (member) {
                type = 'signin';
            } else if (type !== 'subscribe') {
                type = 'signup';
            }
        }
        return this._magicLinkService.sendMagicLink({email, type, requestSrc, tokenData: Object.assign({email}, tokenData)});
    }

    async getMagicLink({email}) {
        this._magicLinkService.getMagicLink({tokenData: {email}, type: 'signin'});
    }

    async getDataFromToken(token) {
        return await this._magicLinkService.getDataFromToken(token);
    }
};
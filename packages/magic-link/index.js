const jwt = require('jsonwebtoken');

/**
 * @typedef { import('jsonwebtoken').Secret } Secret
 * @typedef { import('nodemailer').Transporter } MailTransporter
 * @typedef { import('nodemailer').SentMessageInfo } SentMessageInfo
 * @typedef { string } JSONWebToken
 * @typedef { string } URL
 */

class MagicLink {
    /**
     * @param {object} options
     * @param {MailTransporter} options.transporter
     * @param {Secret} options.secret
     * @param {(token: JSONWebToken, type: string) => URL} options.getSigninURL
     * @param {typeof defaultGetText} [options.getText]
     * @param {typeof defaultGetHTML} [options.getHTML]
     * @param {typeof defaultGetSubject} [options.getSubject]
     */
    constructor(options) {
        if (!options || !options.transporter || !options.secret || !options.getSigninURL) {
            throw new Error('Missing options. Expects {transporter, secret, getSigninURL}');
        }
        this.transporter = options.transporter;
        this.secret = options.secret;
        this.getSigninURL = options.getSigninURL;
        this.getText = options.getText || defaultGetText;
        this.getHTML = options.getHTML || defaultGetHTML;
        this.getSubject = options.getSubject || defaultGetSubject;
    }

    /**
     * sendMagicLink
     *
     * @param {object} options
     * @param {string} options.email - The email to send magic link to
     * @param {object} options.tokenData - The data for token
     * @param {string=} [options.type='signin'] - The type to be passed to the url and content generator functions
     * @returns {Promise<{token: JSONWebToken, info: SentMessageInfo}>}
     */
    async sendMagicLink(options) {
        const token = jwt.sign(options.tokenData, this.secret, {
            algorithm: 'HS256',
            expiresIn: '10m'
        });

        const type = options.type || 'signin';

        const url = this.getSigninURL(token, type);

        const info = await this.transporter.sendMail({
            to: options.email,
            subject: this.getSubject(type),
            text: this.getText(url, type, options.email),
            html: this.getHTML(url, type, options.email)
        });

        return {token, info};
    }

    /**
     * getMagicLink
     *
     * @param {object} options
     * @param {object} options.tokenData - The data for token
     * @param {string=} [options.type='signin'] - The type to be passed to the url and content generator functions
     * @returns {URL} - signin URL
     */
    getMagicLink(options) {
        const token = jwt.sign(options.tokenData, this.secret, {
            algorithm: 'HS256',
            expiresIn: '10m'
        });

        const type = options.type || 'signin';

        return this.getSigninURL(token, type);
    }

    /**
     * getDataFromToken
     *
     * @param {JSONWebToken} token - The token to decode
     * @returns {object} data - The data object associated with the magic link
     */
    getDataFromToken(token) {
        /** @type {object} */
        const tokenData = (jwt.verify(token, this.secret, {
            algorithms: ['HS256'],
            maxAge: '10m'
        }));
        return tokenData;
    }
}

/**
 * defaultGetText
 *
 * @param {URL} url - The url which will trigger sign in flow
 * @param {string} type - The type of email to send e.g. signin, signup
 * @param {string} email - The recipient of the email to send
 * @returns {string} text - The text content of an email to send
 */
function defaultGetText(url, type, email) {
    let msg = 'sign in';
    if (type === 'signup') {
        msg = 'confirm your email address';
    }
    return `Click here to ${msg} ${url}. This msg was sent to ${email}`;
}

/**
 * defaultGetHTML
 *
 * @param {URL} url - The url which will trigger sign in flow
 * @param {string} type - The type of email to send e.g. signin, signup
 * @param {string} email - The recipient of the email to send
 * @returns {string} HTML - The HTML content of an email to send
 */
function defaultGetHTML(url, type, email) {
    let msg = 'sign in';
    if (type === 'signup') {
        msg = 'confirm your email address';
    }
    return `<a href="${url}">Click here to ${msg}</a> This msg was sent to ${email}`;
}

/**
 * defaultGetSubject
 *
 * @param {string} type - The type of email to send e.g. signin, signup
 * @returns {string} subject - The subject of an email to send
 */
function defaultGetSubject(type) {
    if (type === 'signup') {
        return `Signup!`;
    }
    return `Signin!`;
}

module.exports = MagicLink;

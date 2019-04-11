/* global window document fetch */
const domready = require('domready');
const layer2 = require('@tryghost/members-layer2');

domready(setupMembersListeners);

function reload(success) {
    if (success) {
        window.location.reload();
    }
}

function setupMembersListeners() {
    const members = layer2({membersUrl: window.membersUrl});
    const tokenAudience = new URL(window.location.href).origin + '/ghost/api/v2/members/';

    const [hashMatch, hash, query] = window.location.hash.match(/^#([^?]+)\??(.*)$/) || [];

    if (hashMatch && hash === 'reset-password') {
        const [tokenMatch, token] = query.match(/token=([a-zA-Z0-9-_]+.[a-zA-Z0-9-_]+.[a-zA-Z0-9-_]+)/) || [];
        if (tokenMatch) {
            return members.resetPassword({token})
                .then((success) => {
                    window.location.hash = '';
                    return success;
                })
                .then(reload);
        }
    }

    const signinEls = document.querySelectorAll('[data-members-signin]');
    const upgradeEls = document.querySelectorAll('[data-members-upgrade]');
    const signoutEls = document.querySelectorAll('[data-members-signout]');

    function setCookie(token) {
        return fetch('/members/ssr', {
            method: 'post',
            credentials: 'include',
            body: token
        }).then(function (res) {
            return !!res.ok;
        });
    }

    function removeCookie() {
        return fetch('/members/ssr', {
            method: 'delete'
        }).then(function (res) {
            return !!res.ok;
        });
    }

    members.on('signedin', function () {
        members.getToken({
            audience: tokenAudience
        }).then(function (token) {
            setCookie(token);
        });
    });

    members.on('signedout', function () {
        removeCookie();
    });

    function signout(event) {
        event.preventDefault();
        members.signout()
            .then(() => {
                return removeCookie();
            })
            .then(reload);
    }

    function signin(event) {
        event.preventDefault();
        members.signin()
            .then(() => {
                return members.getToken({
                    audience: tokenAudience,
                    fresh: true
                }).then(function (token) {
                    return setCookie(token);
                });
            })
            .then(reload);
    }

    function upgrade(event) {
        event.preventDefault();
        members.upgrade()
            .then(() => {
                return members.getToken({
                    audience: tokenAudience,
                    fresh: true
                }).then(function (token) {
                    return setCookie(token);
                });
            })
            .then(reload);
    }

    for (let el of signinEls) {
        el.addEventListener('click', signin);
    }

    for (let el of upgradeEls) {
        el.addEventListener('click', upgrade);
    }

    for (let el of signoutEls) {
        el.addEventListener('click', signout);
    }
}

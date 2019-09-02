const should = require('should');
const MagicLink = require('../');

describe('MagicLink', function () {
    it('Exports a function', function () {
        should.equal(typeof MagicLink, 'function');
    });
});

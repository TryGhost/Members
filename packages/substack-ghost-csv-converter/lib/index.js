module.exports = {
    get formatCSV() {
        return require('./format-csv');
    },

    get normalizeMembersCSV() {
        return require('./normalize-members-csv');
    }
};

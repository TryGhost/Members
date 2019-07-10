const hash = data => require('crypto').createHash('sha256').update(data).digest('hex');
const {
    del: stripeDel,
    create: stripeCreate,
    retrieve: stripeRetrieve
} = require('./stripeRequests');

function createDeterministicApi(resource, validResult, getAttrs, generateHashSeed) {
    const get = createGetter(resource, validResult);
    const create = createCreator(resource, getAttrs);
    const remove = createRemover(resource, get, generateHashSeed);
    const ensure = createEnsurer(get, create, generateHashSeed);

    return {
        get, create, remove, ensure
    };
}

function createGetter(resource, validResult) {
    return function get(stripe, object, idSeed) {
        const id = hash(idSeed);
        return stripeRetrieve(stripe, resource, id)
            .then((result) => {
                if (validResult(result)) {
                    return result;
                }
                return get(stripe, object, id);
            }, (err) => {
                err.id_requested = id;
                throw err;
            });
    };
}

function createCreator(resource, getAttrs) {
    return function create(stripe, id, object, ...rest) {
        return stripeCreate(
            stripe,
            resource,
            Object.assign(getAttrs(object, ...rest), {id})
        );
    };
}

function createRemover(resource, get, generateHashSeed) {
    return function remove(stripe, object, ...rest) {
        return get(stripe, object, generateHashSeed(object, ...rest)).then((res) => {
            return stripeDel(stripe, resource, res.id);
        }).catch((err) => {
            if (err.code !== 'resource_missing') {
                throw err;
            }
        });
    };
}

function createEnsurer(get, create, generateHashSeed) {
    return function ensure(stripe, object, ...rest) {
        return get(stripe, object, generateHashSeed(object, ...rest))
            .catch((err) => {
                if (err.code !== 'resource_missing') {
                    throw err;
                }
                const id = err.id_requested;
                return create(stripe, id, object, ...rest);
            });
    };
}

module.exports = createDeterministicApi;

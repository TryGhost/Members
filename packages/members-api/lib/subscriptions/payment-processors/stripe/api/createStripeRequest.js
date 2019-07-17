module.exports = function createStripeRequest(makeRequest) {
    return function stripeRequest(...args) {
        const errorHandler = (err) => {
            switch (err.type) {
            case 'StripeCardError':
                // Card declined
                throw err;
            case 'RateLimitError':
                // Ronseal
                return exponentiallyBackoff(makeRequest, ...args).catch((err) => {
                    // We do not want to recurse further if we get RateLimitError
                    // after running the exponential backoff
                    if (err.type === 'RateLimitError') {
                        throw err;
                    }
                    return errorHandler(err);
                });
            case 'StripeInvalidRequestError':
                // Invalid params to the request
                throw err;
            case 'StripeAPIError':
                // Rare internal server error from stripe
                throw err;
            case 'StripeConnectionError':
                // Weird network/https issue
                throw err;
            case 'StripeAuthenticationError':
                // Invalid API Key (probably)
                throw err;
            default:
                throw err;
            }
        };
        return makeRequest(...args).catch(errorHandler);
    };
};

function exponentiallyBackoff(makeRequest, ...args) {
    function backoffRequest(timeout, ...args) {
        return new Promise(resolve => setTimeout(resolve, timeout)).then(() => {
            return makeRequest(...args).catch((err) => {
                if (err.type !== 'RateLimitError') {
                    throw err;
                }

                if (timeout > 30000) {
                    throw err;
                }

                return backoffRequest(timeout * 2, ...args);
            });
        });
    }

    return backoffRequest(1000, ...args);
}

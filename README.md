# Members

## Install


## Usage


## Develop

This is a mono repository, managed with [lerna](https://lernajs.io/).

1. `git clone` this repo & `cd` into it as usual
2. `yarn setup` is mapped to `lerna bootstrap`
   - installs all external dependencies
   - links all internal dependencies

To add a new package to the repo:
   - install [slimer](https://github.com/TryGhost/slimer)
   - run `slimer new <package name>`

**NOTE**: For most packages in this repo you would need to have [Stripe CLI](https://github.com/stripe/stripe-cli) installed and run this command `stripe listen  --forward-to http://localhost:2368/members/webhooks/stripe/` to be able to listen to webhooks. Ghost instance should be started with `WEBHOOK_SECRET` environmental variable set to whatever the output of above command is (look for string like: `whsec_************`). For example, full command to start Ghost would be: `WEBHOOK_SECRET=whsec_rm6Vc8790h5GOICvFOHhJJMfmfdYxw4P yarn start`

## Run

- `yarn dev`


## Test

- `yarn lint` run just eslint
- `yarn test` run lint and tests


## Publish

- `yarn ship` is an alias for `lerna publish`
    - Publishes all packages which have changed
    - Also updates any packages which depend on changed packages


# Copyright & License

Copyright (c) 2013-2021 Ghost Foundation - Released under the [MIT license](LICENSE).

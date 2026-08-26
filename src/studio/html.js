'use strict';

const {h} = require('preact');
const htmMod = require('htm');
const htm = typeof htmMod === 'function' ? htmMod : htmMod.default;

module.exports = {html: htm.bind(h)};

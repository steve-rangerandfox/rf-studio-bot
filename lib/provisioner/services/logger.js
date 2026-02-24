/**
 * Provisioner-specific logger — wraps the shared createLogger with
 * a provisioner-scoped instance and adds the serviceResult helper.
 */

import { createLogger } from '../../shared/logger.js';

const _log = createLogger('provisioner');

export const logger = {
  info(message, meta) {
    _log.info(message, meta);
  },

  warn(message, meta) {
    _log.warn(message, meta);
  },

  error(message, meta) {
    _log.error(message, meta);
  },

  debug(message, meta) {
    _log.debug(message, meta);
  },

  serviceResult(service, success, urlOrError) {
    if (success) {
      _log.info(`\u2705 ${service} \u2014 ${urlOrError ?? "done"}`);
    } else {
      _log.error(`\u274C ${service} \u2014 ${urlOrError ?? "unknown error"}`);
    }
  },
};

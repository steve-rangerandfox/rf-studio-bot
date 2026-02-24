/**
 * Structured console logger for RF Studio Bot.
 * Returns scoped {info, warn, error, debug} methods with ISO timestamps.
 *
 * Usage:
 *   import { createLogger } from '../../lib/shared/logger.js';
 *   const log = createLogger('deck');
 *   log.info('Template loaded', { id: 'abc' });
 */

/**
 * Create a scoped logger instance.
 * @param {string} prefix  Module or feature name (e.g. 'auth', 'deck', 'provisioner')
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function }}
 */
export function createLogger(prefix) {
  function fmt(level, message, data) {
    const ts = new Date().toISOString();
    const base = `[${ts}] [${level}] [${prefix}] ${message}`;
    if (data !== undefined) {
      return `${base} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
    }
    return base;
  }

  return {
    info(message, data) {
      console.log(fmt('INFO', message, data));
    },
    warn(message, data) {
      console.warn(fmt('WARN', message, data));
    },
    error(message, data) {
      console.error(fmt('ERROR', message, data));
    },
    debug(message, data) {
      console.debug(fmt('DEBUG', message, data));
    },
  };
}

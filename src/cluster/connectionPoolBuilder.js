const { KafkaJSConnectionError, KafkaJSNonRetriableError } = require('../errors')
const ConnectionPool = require('../network/connectionPool')

/**
 * @typedef {Object} ConnectionPoolBuilder
 * @property {(destination?: { host?: string, port?: number, rack?: string }) => Promise<ConnectionPool>} build
 */

/**
 * @param {Object} options
 * @param {import("../../types").ISocketFactory} [options.socketFactory]
 * @param {string[]|(() => string[])} options.brokers
 * @param {Object} [options.ssl]
 * @param {Object} [options.sasl]
 * @param {string} options.clientId
 * @param {number} options.requestTimeout
 * @param {boolean} [options.enforceRequestTimeout]
 * @param {number} [options.connectionTimeout]
 * @param {number} [options.maxInFlightRequests]
 * @param {import("../../types").RetryOptions} [options.retry]
 * @param {import("../../types").Logger} options.logger
 * @param {import("../instrumentation/emitter")} [options.instrumentationEmitter]
 * @param {number} [options.reauthenticationThreshold]
 * @returns {ConnectionPoolBuilder}
 */
module.exports = ({
  socketFactory,
  brokers,
  ssl,
  sasl,
  clientId,
  requestTimeout,
  enforceRequestTimeout,
  connectionTimeout,
  maxInFlightRequests,
  logger,
  instrumentationEmitter = null,
  reauthenticationThreshold,
}) => {
  let index = 0

  const isValidBroker = broker => {
    return broker && typeof broker === 'string' && broker.length > 0
  }

  const validateBrokers = brokers => {
    if (!brokers) {
      throw new KafkaJSNonRetriableError(`Failed to connect: brokers should not be null`)
    }

    if (Array.isArray(brokers)) {
      if (!brokers.length) {
        throw new KafkaJSNonRetriableError(`Failed to connect: brokers array is empty`)
      }

      brokers.forEach((broker, index) => {
        if (!isValidBroker(broker)) {
          throw new KafkaJSNonRetriableError(
            `Failed to connect: broker at index ${index} is invalid "${typeof broker}"`
          )
        }
      })
    }
  }

  const getBrokers = async () => {
    let list

    if (typeof brokers === 'function') {
      try {
        list = await brokers()
      } catch (e) {
        const wrappedError = new KafkaJSConnectionError(
          `Failed to connect: "config.brokers" threw: ${e.message}`
        )
        wrappedError.stack = `${wrappedError.name}\n  Caused by: ${e.stack}`
        throw wrappedError
      }
    } else {
      list = brokers
    }

    validateBrokers(list)

    return list
  }

  return {
    build: async ({ host, port, rack } = {}) => {
      if (!host) {
        const list = await getBrokers()

        const randomBroker = list[index++ % list.length]

        // awhittier: Works for server:9902, 10.1.2.3:9902, and ::1:9902.
        const lastColonIdx = randomBroker.lastIndexOf(':')
        if (lastColonIdx === -1 || lastColonIdx === randomBroker.length - 1) {
          throw new KafkaJSNonRetriableError(
            `Failed to connect: host ${randomBroker} did not contain a host and port separated by a colon`
          )
        }
        host = randomBroker.substring(0, lastColonIdx)
        port = Number(randomBroker.substring(lastColonIdx + 1))
      }

      return new ConnectionPool({
        host,
        port,
        rack,
        sasl,
        ssl,
        clientId,
        socketFactory,
        connectionTimeout,
        requestTimeout,
        enforceRequestTimeout,
        maxInFlightRequests,
        instrumentationEmitter,
        logger,
        reauthenticationThreshold,
      })
    },
  }
}

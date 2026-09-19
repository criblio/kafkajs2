const seq = require('../utils/seq')
const createFetcher = require('./fetcher')
const createWorker = require('./worker')
const createWorkerQueue = require('./workerQueue')
const { KafkaJSFetcherRebalanceError, KafkaJSNoBrokerAvailableError } = require('../errors')

/** @typedef {ReturnType<typeof createFetchManager>} FetchManager */

/**
 * @param {object} options
 * @param {import('../../types').Logger} options.logger
 * @param {() => number[]} options.getNodeIds
 * @param {(nodeId: number) => Promise<import('../../types').Batch[]>} options.fetch
 * @param {import('./worker').Handler<T>} options.handler
 * @param {number} [options.concurrency]
 * @template T
 */
const createFetchManager = ({
  logger: rootLogger,
  getNodeIds,
  fetch,
  handler,
  concurrency = 1,
}) => {
  const logger = rootLogger.namespace('FetchManager')
  const workers = seq(concurrency, workerId => createWorker({ handler, workerId }))
  const workerQueue = createWorkerQueue({ workers })

  let fetchers = []
  let stopping = false

  const getFetchers = () => fetchers

  const createFetchers = () => {
    const nodeIds = getNodeIds()
    const partitionAssignments = new Map()

    if (nodeIds.length === 0) {
      throw new KafkaJSNoBrokerAvailableError()
    }

    const validateShouldRebalance = () => {
      const current = getNodeIds()
      const hasChanged =
        nodeIds.length !== current.length || nodeIds.some(nodeId => !current.includes(nodeId))
      if (hasChanged && current.length !== 0) {
        throw new KafkaJSFetcherRebalanceError()
      }
    }

    const fetchers = nodeIds.map(nodeId =>
      createFetcher({
        nodeId,
        workerQueue,
        partitionAssignments,
        fetch: async nodeId => {
          validateShouldRebalance()
          return fetch(nodeId)
        },
        logger,
      })
    )

    logger.debug(`Created ${fetchers.length} fetchers`, { nodeIds, concurrency })
    return fetchers
  }

  const start = async () => {
    logger.debug('Starting...')
    stopping = false

    while (true) {
      fetchers = createFetchers()

      try {
        await Promise.all(fetchers.map(fetcher => fetcher.start()))
      } catch (error) {
        await stopFetchers()

        // a rebalance landing while the consumer stops must not build another generation:
        // `stop()` may already have returned, and nothing would ever stop this one
        if (!stopping && error instanceof KafkaJSFetcherRebalanceError) {
          logger.debug('Rebalancing fetchers...')
          continue
        }

        throw error
      }

      break
    }
  }

  // the internal teardown, used by the rebalance path. deliberately does not set
  // `stopping`: sharing one function would mark every internal rebalance as a stop and
  // the loop above would never rebalance again.
  const stopFetchers = async () => {
    await Promise.all(fetchers.map(fetcher => fetcher.stop()))
  }

  const stop = async () => {
    logger.debug('Stopping fetchers...')
    stopping = true
    await stopFetchers()
    logger.debug('Stopped fetchers')
  }

  return { start, stop, getFetchers }
}

module.exports = createFetchManager

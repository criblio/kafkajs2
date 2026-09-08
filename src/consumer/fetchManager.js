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
  /**
   * Every fetcher array created by an in-flight `start()`. `stop()` must walk this set: a single
   * `fetchers` binding is overwritten when a new generation is built, which is how overlapping
   * `start()` calls (Runner `Promise.race` vs retrier) orphan live fetchers.
   */
  const generations = new Set()
  let startPromise = null
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

  const stopGeneration = async generation => {
    if (!generations.has(generation)) {
      return
    }

    await Promise.all(generation.map(fetcher => fetcher.stop()))
    generations.delete(generation)

    if (fetchers === generation) {
      fetchers = []
    }
  }

  const run = async () => {
    logger.debug('Starting...')
    stopping = false

    while (!stopping) {
      const currentFetchers = createFetchers()
      fetchers = currentFetchers
      generations.add(currentFetchers)

      try {
        await Promise.all(currentFetchers.map(fetcher => fetcher.start()))
      } catch (error) {
        // Stop only this generation. Calling the shared `stop()` would tear down a newer
        // generation if one existed.
        await stopGeneration(currentFetchers)

        if (!stopping && error instanceof KafkaJSFetcherRebalanceError) {
          logger.debug('Rebalancing fetchers...')
          continue
        }

        throw error
      }

      break
    }
  }

  const start = () => {
    // One lifecycle at a time. A second `start()` while fetchers are still running used to
    // replace `fetchers` and leave the previous generation unreachable from `stop()`.
    if (startPromise != null) {
      return startPromise
    }

    startPromise = run().finally(() => {
      startPromise = null
    })
    return startPromise
  }

  const stop = async () => {
    logger.debug('Stopping fetchers...')
    stopping = true
    const pendingStart = startPromise
    await Promise.all(Array.from(generations, stopGeneration))
    if (pendingStart != null) {
      await pendingStart.catch(() => {})
    }
    logger.debug('Stopped fetchers')
  }

  return { start, stop, getFetchers }
}

module.exports = createFetchManager

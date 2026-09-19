const sleep = require('../utils/sleep')
const seq = require('../utils/seq')
const createFetchManager = require('./fetchManager')
const Batch = require('./batch')
const { newLogger } = require('testHelpers')
const waitFor = require('../utils/waitFor')
const { KafkaJSNonRetriableError, KafkaJSNoBrokerAvailableError } = require('../errors')

describe('FetchManager', () => {
  let fetchManager, fetch, handler, getNodeIds, concurrency, batchSize

  const createTestFetchManager = partial =>
    createFetchManager({ logger: newLogger(), concurrency, fetch, handler, getNodeIds, ...partial })

  beforeEach(() => {
    batchSize = 10
    fetch = jest.fn(async nodeId =>
      seq(
        batchSize,
        id =>
          new Batch('test-topic', 0, {
            partition: `${nodeId}${id}`,
            highWatermark: '100',
            messages: [],
          })
      )
    )
    handler = jest.fn(async () => {
      await sleep(20)
    })
    getNodeIds = jest.fn(() => seq(4))
    concurrency = 3
    fetchManager = createTestFetchManager()
  })

  afterEach(async () => {
    fetchManager && (await fetchManager.stop())
  })

  /**
   * CRIBL-44273: `start()` rebalances by looping - stop the generation, build the next one
   * from the new node set. A rebalance landing while the consumer is stopping used to
   * `continue` regardless, so a generation could be born after `stop()` had already
   * returned, with nothing left holding a reference to it.
   */
  it('should not build another generation when a rebalance lands while stopping', async () => {
    let nodeIds = [1, 2]
    const parked = {}
    let externalStopReturned = false
    let fetchesAfterExternalStop = 0

    getNodeIds = jest.fn(() => nodeIds)
    fetch = jest.fn(nodeId => {
      if (externalStopReturned) fetchesAfterExternalStop++
      return new Promise(resolve => {
        parked[nodeId] = resolve
      })
    })
    fetchManager = createTestFetchManager({ concurrency: 1 })

    const started = fetchManager.start().catch(() => {})
    await waitFor(() => Object.keys(parked).length === 2, { maxWait: 2000 })
    const firstGeneration = fetchManager.getFetchers()

    // a rebalance lands: the node set changes, so the next `validateShouldRebalance` throws
    nodeIds = [3]
    parked[1]([]) // fetcher 1 re-enters, throws, and rejects the generation

    // the internal teardown now waits on fetcher 2, which is still parked. the consumer
    // stops inside that wait - the window where the loop used to `continue` into a
    // generation nobody owns
    await sleep(10)
    const externalStop = fetchManager.stop()
    await sleep(10)
    parked[2]([])

    await externalStop
    externalStopReturned = true
    await Promise.all([started, sleep(50)])

    expect(fetchManager.getFetchers()).toBe(firstGeneration)
    expect(fetchesAfterExternalStop).toBe(0)
    expect(Object.keys(parked)).toHaveLength(2) // no third fetcher for the new node set
  })

  it('should construct fetchers and workers', async () => {
    fetchManager.start()

    const fetchers = fetchManager.getFetchers()
    expect(fetchers).toHaveLength(getNodeIds().length)

    const workerQueue = fetchers[0].getWorkerQueue()
    const workers = workerQueue.getWorkers()
    expect(workers).toHaveLength(concurrency)
  })

  it('should finish processing other batches in case of an error from any single worker', async () => {
    handler.mockImplementationOnce(() => {
      throw new Error('test')
    })
    await expect(fetchManager.start()).toReject()
    expect(handler).toHaveBeenCalledTimes(getNodeIds().length * batchSize)
  })

  it('should rebalance fetchers in case of change in nodeIds', async () => {
    getNodeIds.mockImplementation(() => seq(2))

    fetchManager = createTestFetchManager({ concurrency: 3 })
    fetchManager.start()

    let fetchers = fetchManager.getFetchers()
    expect(fetchers).toHaveLength(2)

    getNodeIds.mockImplementation(() => seq(3))

    fetch.mockClear()
    await waitFor(() => fetch.mock.calls.length > 0)

    fetchers = fetchManager.getFetchers()
    expect(fetchers).toHaveLength(3)
  })

  describe('when all brokers have become unavailable', () => {
    it('should not rebalance and let the error bubble up', async () => {
      const fetchMock = jest.fn().mockImplementation(async nodeId => {
        if (!getNodeIds().includes(nodeId)) {
          throw new KafkaJSNonRetriableError('Node not found')
        }

        return fetch(nodeId)
      })
      getNodeIds.mockImplementation(() => seq(1))

      fetchManager = createTestFetchManager({ concurrency: 1, fetch: fetchMock })
      const fetchManagerPromise = fetchManager.start()

      expect(fetchManager.getFetchers()).toHaveLength(1)

      getNodeIds.mockImplementation(() => seq(0))
      await expect(fetchManagerPromise).rejects.toThrow('Node not found')
    })
  })

  it('should throw an error when there are no brokers available', async () => {
    getNodeIds.mockImplementation(() => seq(0))

    await expect(fetchManager.start()).rejects.toThrowError(new KafkaJSNoBrokerAvailableError())
  })
})

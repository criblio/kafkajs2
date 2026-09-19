const Runner = require('../runner')
const Batch = require('../batch')
const InstrumentationEventEmitter = require('../../instrumentation/emitter')
const { newLogger, secureRandom, waitFor } = require('testHelpers')
const sleep = require('../../utils/sleep')
const {
  KafkaJSProtocolError,
  KafkaJSNotImplemented,
  KafkaJSNumberOfRetriesExceeded,
  KafkaJSNoBrokerAvailableError,
} = require('../../errors')
const { createErrorFromCode } = require('../../protocol/error')

const UNKNOWN = -1
const REBALANCE_IN_PROGRESS = 27
const UNKNOWN_MEMBER_ID = 25
const rebalancingError = () => new KafkaJSProtocolError(createErrorFromCode(REBALANCE_IN_PROGRESS))
const unknownMemberError = () => new KafkaJSProtocolError(createErrorFromCode(UNKNOWN_MEMBER_ID))

describe('Consumer > Runner', () => {
  let runner,
    consumerGroup,
    onCrash,
    eachBatch,
    topicName,
    partition,
    emptyBatch,
    instrumentationEmitter

  const createTestRunner = partial => {
    return new Runner({
      consumerGroup,
      onCrash,
      instrumentationEmitter,
      logger: newLogger(),
      eachBatch,
      concurrency: 1,
      ...partial,
    })
  }

  beforeEach(() => {
    topicName = `topic-${secureRandom()}`
    partition = 0

    emptyBatch = new Batch(topicName, 0, {
      partition,
      highWatermark: 5,
      messages: [],
    })

    eachBatch = jest.fn()
    onCrash = jest.fn()
    consumerGroup = {
      getNodeIds: jest.fn(() => [1, 2, 3]),
      connect: jest.fn(),
      join: jest.fn(),
      sync: jest.fn(),
      joinAndSync: jest.fn(),
      fetch: jest.fn(async () => [emptyBatch]),
      resolveOffset: jest.fn(),
      commitOffsets: jest.fn(),
      commitOffsetsIfNecessary: jest.fn(),
      uncommittedOffsets: jest.fn(),
      heartbeat: jest.fn(),
      assigned: jest.fn(() => []),
      isLeader: jest.fn(() => true),
      isPaused: jest.fn().mockReturnValue(false),
    }
    instrumentationEmitter = new InstrumentationEventEmitter()

    runner = createTestRunner()
  })

  afterEach(async () => {
    runner && (await runner.stop())
  })

  describe('when the group is rebalancing before the new consumer has joined', () => {
    it('recovers from rebalance in progress and re-join the group', async () => {
      consumerGroup.sync
        .mockImplementationOnce(() => {
          throw rebalancingError()
        })
        .mockImplementationOnce(() => {
          throw rebalancingError()
        })
        .mockImplementationOnce(() => true)

      runner.scheduleFetchManager = jest.fn()
      await runner.start()
      expect(runner.scheduleFetchManager).toHaveBeenCalled()
      expect(onCrash).not.toHaveBeenCalled()
    })
  })

  describe('when the runner heartbeats ad-hoc', () => {
    it('should send a heartbeat alongside the start the `fetchManager`', async () => {
      runner.heartbeat = jest.fn().mockImplementation(async () => {})

      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(10)
        return []
      })

      await runner.start()

      expect(runner.heartbeat).toHaveBeenCalledTimes(1) // triggered along with fetchManager.start().
      await waitFor(() => runner.heartbeat.mock.calls.length > 1, { maxWait: 200 })
    })

    it('should send heartbeat before retrying a failed fetch operation', async () => {
      runner.heartbeat = jest.fn().mockImplementation(async () => {})

      const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

      let fetchProm
      const fetch = new Promise(resolve => {
        fetchProm = resolve
      })
      consumerGroup.getNodeIds = jest.fn(() => [1])

      consumerGroup.fetch = jest.fn().mockImplementation(() => {
        return fetch.then(() => {
          return Promise.reject(new Error('WTF!')) // retriable error
        })
      })

      await runner.start()
      expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)

      expect(runner.heartbeat).toHaveBeenCalledTimes(1) // triggered along with fetchManager.start().

      fetchProm()

      await waitFor(() => runner.heartbeat.mock.calls.length === 2, { maxWait: 200 }) // triggered from catch, before retrying.

      await waitFor(() => fetchManagerStartSpy.mock.calls.length === 2, { maxWait: 200 }) // second call to fetchManager.start() on retry
    })

    /**
     * The heartbeat is injected at `consumerGroup.heartbeat` rather than `runner.heartbeat`:
     * `runner.heartbeat` is wrapped in `sharedPromiseTo`, so replacing it with a plain
     * `jest.fn` gives every caller its own promise and erases the coupling under test.
     */
    it('should detect a rebalance and rejoin before starting a fetch', async () => {
      consumerGroup.heartbeat = jest
        .fn()
        .mockImplementationOnce(async () => {
          await sleep(10)
          throw rebalancingError()
        })
        .mockImplementation(async () => {})

      const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(10)
        return []
      })

      await runner.start()

      expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
      expect(fetchManagerStartSpy).not.toHaveBeenCalled() // the heartbeat is awaited first

      await waitFor(() => consumerGroup.joinAndSync.mock.calls.length === 2, { maxWait: 2000 }) // rejoin after rebalance was detected
      await waitFor(() => fetchManagerStartSpy.mock.calls.length === 1, { maxWait: 2000 })

      // exactly one generation: the rebalance was handled before any fetch was issued, so
      // there is no abandoned `start()` to drain and none to orphan
      expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)
    })

    it('should detect when the consumer becomes unknown to the coordinator and rejoin before starting a fetch', async () => {
      consumerGroup.heartbeat = jest
        .fn()
        .mockImplementationOnce(async () => {
          await sleep(10)
          throw unknownMemberError()
        })
        .mockImplementation(async () => {})

      const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(10)
        return []
      })

      await runner.start()

      expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
      expect(fetchManagerStartSpy).not.toHaveBeenCalled() // the heartbeat is awaited first

      await waitFor(() => consumerGroup.joinAndSync.mock.calls.length === 2, { maxWait: 2000 }) // rejoin after coordinator rejects this consumer
      await waitFor(() => fetchManagerStartSpy.mock.calls.length === 1, { maxWait: 2000 })

      expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)
    })

    /**
     * States the invariant directly rather than through a symptom: `start()` is never
     * re-entered while a previous call is still in flight, so only one fetcher generation
     * can exist and `stop()` can always reach it. Checked on every call across many rejoins,
     * not sampled at one instant.
     */
    it('should never overlap fetch manager lifecycles across repeated rejoins', async () => {
      let heartbeats = 0
      consumerGroup.heartbeat = jest.fn().mockImplementation(async () => {
        await sleep(5)
        if (++heartbeats <= 3) {
          throw rebalancingError()
        }
      })

      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(5)
        return []
      })

      let inFlight = 0
      let maxInFlight = 0
      const start = runner.fetchManager.start.bind(runner.fetchManager)
      jest.spyOn(runner.fetchManager, 'start').mockImplementation(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        try {
          return await start()
        } finally {
          inFlight--
        }
      })

      await runner.start()
      await waitFor(() => consumerGroup.joinAndSync.mock.calls.length === 4, { maxWait: 3000 }) // join + 3 rejoins
      await waitFor(() => consumerGroup.fetch.mock.calls.length > 2, { maxWait: 3000 })

      expect(maxInFlight).toBe(1)
    })

    const nonRetriables = [
      { Clazz: KafkaJSNoBrokerAvailableError, name: 'KafkaJSNoBrokerAvailableError' },
      { Clazz: KafkaJSNotImplemented, name: 'KafkaJSNotImplemented' },
    ]
    nonRetriables.forEach(args => {
      it(`should not send heartbeat with non-retriable errors but allow the consumer to crash - ${args.name}`, async () => {
        runner.heartbeat = jest.fn().mockImplementation(async () => {})

        let fetchProm
        const fetch = new Promise(resolve => {
          fetchProm = resolve
        })
        consumerGroup.getNodeIds = jest.fn(() => [1])

        consumerGroup.fetch = jest.fn().mockImplementation(() => {
          return fetch.then(() => {
            return Promise.reject(new args.Clazz('WTF!'))
          })
        })

        await runner.start()
        expect(runner.heartbeat).toHaveBeenCalledTimes(1)
        fetchProm()
        await waitFor(() => onCrash.mock.calls.length === 1, { maxWait: 200 })
      })
    })

    describe('when heartbeating before retrying', () => {
      it('should detect a rebalance and rejoin', async () => {
        runner.heartbeat = jest
          .fn()
          .mockImplementationOnce(() => {}) // 1st heartbeat succeeds
          .mockImplementationOnce(async () => {
            await sleep(100)
            throw rebalancingError() // 2nd heartbeat fails with a rebalance error
          })

        const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

        consumerGroup.getNodeIds = jest.fn(() => [1])
        consumerGroup.fetch = jest.fn().mockImplementation(async () => {
          throw new Error('WTF!')
        })

        await runner.start()

        expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
        expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)
        expect(runner.heartbeat).toHaveBeenCalledTimes(1) // triggered along with fetchManager.start().

        await waitFor(() => consumerGroup.joinAndSync.mock.calls.length === 2, { maxWait: 200 }) // rejoin after rebalance was detected
      })

      it('should  when the consumer becomes unknown to the coordinator and rejoin', async () => {
        runner.heartbeat = jest
          .fn()
          .mockImplementationOnce(() => {}) // 1st heartbeat succeeds
          .mockImplementationOnce(async () => {
            await sleep(100)
            throw unknownMemberError() // 2nd heartbeat fails with the unknown-member error
          })

        const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

        consumerGroup.getNodeIds = jest.fn(() => [1])
        consumerGroup.fetch = jest.fn().mockImplementation(async () => {
          throw new Error('WTF!')
        })

        await runner.start()

        expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
        expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)
        expect(runner.heartbeat).toHaveBeenCalledTimes(1) // triggered along with fetchManager.start().

        await waitFor(() => consumerGroup.joinAndSync.mock.calls.length === 2, { maxWait: 200 }) // rejoin after rebalance was detected
      })

      it('should pass along the first error if heartbeat fails as well', async () => {
        runner.heartbeat = jest
          .fn()
          .mockImplementationOnce(() => {}) // 1st heartbeat succeeds
          .mockImplementationOnce(async () => {
            await sleep(100)
            throw new Error('WTF') // 2nd heartbeat fails with retriable error
          })

        const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

        consumerGroup.getNodeIds = jest.fn(() => [1])
        consumerGroup.fetch = jest.fn().mockImplementation(async () => {
          const nonRetriableError = new Error('Non-retriable - WTF!')
          nonRetriableError.retriable = false
          throw nonRetriableError
        })

        await runner.start()

        expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
        expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)
        expect(runner.heartbeat).toHaveBeenCalledTimes(1) // triggered along with fetchManager.start().
        await waitFor(() => onCrash.mock.calls.length === 1, { maxWait: 200 }) // due to the retrier getting a non-retriable error thus aborting
        await waitFor(() => runner.heartbeat.mock.calls.length === 2, { maxWait: 200 }) // 2nd call from within the catch block
        expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('when a fetcher generation outlives the fetch manager', () => {
    /**
     * A spin regresses by starving the event loop, so a plain assertion would hang the suite
     * rather than fail it. Counting re-entries and throwing past a cap breaks the loop and
     * lets the test report the real number.
     */
    const countFetchReEntriesAfterStop = () => {
      // high enough that a healthy run never reaches it, low enough to break the spin fast
      const MAX_RE_ENTRIES = 5000
      const counter = { value: 0 }
      const fetch = runner.fetch.bind(runner)

      jest.spyOn(runner, 'fetch').mockImplementation(async nodeId => {
        if (!runner.running && ++counter.value > MAX_RE_ENTRIES) {
          throw new Error('fetch re-entered after stop')
        }

        return fetch(nodeId)
      })

      return counter
    }

    /**
     * CRIBL-44273: an abandoned generation used to keep calling `Runner.fetch`, which returned
     * `[]` as soon as `running` went false. Its `while (isRunning)` loop then spun on
     * microtasks - one core pegged, no log line, no recovery. Any orphan must die instead.
     */
    it('should not re-enter fetch once the consumer stops', async () => {
      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(5)
        return []
      })

      const reEntries = countFetchReEntriesAfterStop()

      await runner.start()
      await waitFor(() => consumerGroup.fetch.mock.calls.length > 0, { maxWait: 2000 })

      // orphan the live generation the way losing the heartbeat race used to: a second
      // `start()` replaces `fetchers`, leaving the first generation unreachable from `stop()`
      const abandoned = runner.fetchManager.start().catch(() => {})
      await waitFor(() => consumerGroup.fetch.mock.calls.length > 1, { maxWait: 2000 })

      await runner.stop()
      const fetchesAtStop = consumerGroup.fetch.mock.calls.length

      // each live fetcher may enter `fetch` once more before its loop unwinds; none may loop
      expect(reEntries.value).toBeLessThanOrEqual(2)

      await sleep(100)
      expect(reEntries.value).toBeLessThanOrEqual(2)
      expect(consumerGroup.fetch).toHaveBeenCalledTimes(fetchesAtStop)

      await abandoned
    })

    /**
     * The runner checks `running` at the top of the retrier body, then awaits the heartbeat
     * before calling `start()`. A `stop()` landing inside that await runs `fetchManager.stop()`
     * against an empty `fetchers` array, so the generation `start()` goes on to create is born
     * after its stop has already passed - unreachable, exactly like a raced orphan. The
     * re-check after the heartbeat keeps it from being created at all; the throw in `fetch()`
     * is the backstop. Without either, it spins and `Runner.stop()` never returns.
     */
    it('should not leave a generation running when stop lands mid-heartbeat', async () => {
      let releaseHeartbeat
      consumerGroup.heartbeat = jest.fn().mockImplementation(
        () =>
          new Promise(resolve => {
            releaseHeartbeat = resolve
          })
      )
      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(5)
        return []
      })

      const reEntries = countFetchReEntriesAfterStop()

      await runner.start()
      await waitFor(() => consumerGroup.heartbeat.mock.calls.length === 1, { maxWait: 2000 })
      expect(runner.fetch).not.toHaveBeenCalled() // parked before `fetchManager.start()`

      const stopped = runner.stop() // `running` goes false while the heartbeat is parked
      releaseHeartbeat() // the retrier now walks into `fetchManager.start()`

      await stopped // must not hang
      await sleep(100)

      // zero rather than merely bounded: the re-check means no generation is created at
      // all, so nothing ever has to unwind. a bounded count would also pass on the backstop
      // alone, and would not notice the re-check going away.
      expect(reEntries.value).toBe(0)
      expect(runner.fetch).not.toHaveBeenCalled()
      expect(consumerGroup.fetch).not.toHaveBeenCalled() // nothing ever reached the broker
      expect(onCrash).not.toHaveBeenCalled() // a deliberate stop is not a crash
    })
  })

  it('should "commit" offsets during fetch', async () => {
    const batch = new Batch(topicName, 0, {
      partition,
      highWatermark: 5,
      messages: [{ offset: 4, key: '1', value: '2' }],
    })

    runner.scheduleFetchManager = jest.fn()
    await runner.start()
    await runner.handleBatch(batch) // Manually fetch for test
    expect(eachBatch).toHaveBeenCalled()
    expect(consumerGroup.commitOffsets).toHaveBeenCalled()
    expect(onCrash).not.toHaveBeenCalled()
  })

  describe('"eachBatch" callback', () => {
    it('allows providing offsets to "commitOffsetIfNecessary"', async () => {
      const batch = new Batch(topicName, 0, {
        partition,
        highWatermark: 5,
        messages: [{ offset: 4, key: '1', value: '2' }],
      })

      runner.scheduleFetchManager = jest.fn()
      await runner.start()
      await runner.handleBatch(batch) // Manually fetch for test

      expect(eachBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          commitOffsetsIfNecessary: expect.any(Function),
        })
      )

      const { commitOffsetsIfNecessary } = eachBatch.mock.calls[0][0] // Access the callback

      // Clear state
      consumerGroup.commitOffsetsIfNecessary.mockClear()
      consumerGroup.commitOffsets.mockClear()

      // No offsets provided
      await commitOffsetsIfNecessary()
      expect(consumerGroup.commitOffsetsIfNecessary).toHaveBeenCalledTimes(1)
      expect(consumerGroup.commitOffsets).toHaveBeenCalledTimes(0)

      // Clear state
      consumerGroup.commitOffsetsIfNecessary.mockClear()
      consumerGroup.commitOffsets.mockClear()

      // Provide offsets
      const offsets = {
        topics: [{ topic: topicName, partitions: [{ offset: '1', partition: 0 }] }],
      }

      await commitOffsetsIfNecessary(offsets)
      expect(consumerGroup.commitOffsetsIfNecessary).toHaveBeenCalledTimes(0)
      expect(consumerGroup.commitOffsets).toHaveBeenCalledTimes(1)
      expect(consumerGroup.commitOffsets).toHaveBeenCalledWith(offsets)
    })
  })

  describe('when eachBatchAutoResolve is set to false', () => {
    beforeEach(() => {
      runner = createTestRunner({ eachBatchAutoResolve: false })
      runner.scheduleFetchManager = jest.fn()
    })

    it('does not call resolveOffset with the last offset', async () => {
      const batch = new Batch(topicName, 0, {
        partition,
        highWatermark: 5,
        messages: [{ offset: 4, key: '1', value: '2' }],
      })

      await runner.start()
      await runner.handleBatch(batch)
      expect(onCrash).not.toHaveBeenCalled()
      expect(consumerGroup.resolveOffset).not.toHaveBeenCalled()
    })
  })

  describe('when autoCommit is set to false', () => {
    let eachBatchCallUncommittedOffsets

    beforeEach(() => {
      eachBatchCallUncommittedOffsets = jest.fn(async ({ uncommittedOffsets }) => {
        uncommittedOffsets()
      })

      runner = createTestRunner({ autoCommit: false, eachBatch: eachBatchCallUncommittedOffsets })
      runner.scheduleFetchManager = jest.fn(() => runner.consume())
    })

    it('should not commit offsets during fetch', async () => {
      const batch = new Batch(topicName, 0, {
        partition,
        highWatermark: 5,
        messages: [{ offset: 4, key: '1', value: '2' }],
      })

      runner.scheduleFetchManager = jest.fn()
      await runner.start()
      await runner.handleBatch(batch) // Manually fetch for test

      expect(consumerGroup.commitOffsets).not.toHaveBeenCalled()
      expect(consumerGroup.commitOffsetsIfNecessary).not.toHaveBeenCalled()
      expect(eachBatchCallUncommittedOffsets).toHaveBeenCalled()
      expect(consumerGroup.uncommittedOffsets).toHaveBeenCalled()

      expect(onCrash).not.toHaveBeenCalled()
    })
  })

  it('calls onCrash for any other errors', async () => {
    const unknownError = new KafkaJSProtocolError(createErrorFromCode(UNKNOWN))
    consumerGroup.joinAndSync
      .mockImplementationOnce(() => {
        throw unknownError
      })
      .mockImplementationOnce(() => true)

    runner.scheduleFetchManager = jest.fn()
    await runner.start()

    await waitFor(() => onCrash.mock.calls.length > 0)

    expect(runner.scheduleFetchManager).not.toHaveBeenCalled()
    expect(onCrash).toHaveBeenCalledWith(unknownError)
  })

  it('crashes on KafkaJSNotImplemented errors', async () => {
    const notImplementedError = new KafkaJSNotImplemented('not implemented')
    consumerGroup.fetch.mockImplementationOnce(() => Promise.reject(notImplementedError))

    await runner.start()

    await waitFor(() => onCrash.mock.calls.length > 0)
    expect(onCrash).toHaveBeenCalledWith(notImplementedError)
  })

  describe('commitOffsets', () => {
    let offsets

    beforeEach(async () => {
      offsets = { topics: [{ topic: topicName, partitions: [{ offset: '1', partition }] }] }

      consumerGroup.joinAndSync.mockClear()
      consumerGroup.commitOffsetsIfNecessary.mockClear()
      consumerGroup.commitOffsets.mockClear()
    })

    it('should commit offsets while running', async () => {
      await runner.start()
      await runner.commitOffsets(offsets)

      expect(consumerGroup.commitOffsetsIfNecessary).toHaveBeenCalledTimes(0)
      expect(consumerGroup.commitOffsets.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(consumerGroup.commitOffsets).toHaveBeenCalledWith(offsets)
    })

    it('should throw when group is rebalancing', async () => {
      const error = rebalancingError()
      consumerGroup.commitOffsets.mockImplementationOnce(() => {
        throw error
      })

      runner.scheduleFetchManager = jest.fn()
      await runner.start()

      consumerGroup.joinAndSync.mockClear()

      await expect(runner.commitOffsets(offsets)).rejects.toThrow(error.message)
    })

    it('correctly catch exceptions in parallel "eachBatch" processing', async () => {
      runner = createTestRunner({
        eachBatchAutoResolve: false,
        eachBatch: async () => {
          throw new Error('Error while processing batches in parallel')
        },
        concurrency: 10,
        retry: { retries: 0 },
      })

      const batch = new Batch(topicName, 0, {
        partition,
        highWatermark: 5,
        messages: [{ offset: 4, key: '1', value: '2' }],
      })

      const longRunningRequest = () =>
        new Promise(resolve => {
          setTimeout(() => resolve([]), 100)
        })

      consumerGroup.fetch
        .mockImplementationOnce(longRunningRequest)
        .mockImplementationOnce(async () => [batch])

      await runner.start()

      await waitFor(() => onCrash.mock.calls.length > 0)
      await expect(onCrash).toHaveBeenCalledWith(expect.any(KafkaJSNumberOfRetriesExceeded))
    })

    it('correctly catch exceptions in parallel "heartbeat" processing', async () => {
      const batch = new Batch(topicName, 0, {
        partition,
        highWatermark: 5,
        messages: [{ offset: 4, key: '1', value: '2' }],
      })

      const longRunningRequest = () =>
        new Promise(resolve => {
          setTimeout(() => resolve([]), 100)
        })

      const error = new Error('Error while processing heartbeats in parallel')
      consumerGroup.heartbeat = async () => {
        throw error
      }

      consumerGroup.fetch
        .mockImplementation(longRunningRequest)
        .mockImplementationOnce(async () => [batch])

      await runner.start()

      await waitFor(() => onCrash.mock.calls.length > 0)
      expect(onCrash).toHaveBeenCalledWith(error)
    })

    /**
     * This used to resolve with an empty batch list, which let an abandoned fetcher loop
     * forever. The error is absorbed by the fetcher loop and by the runner's catch, which
     * short-circuits while `running` is false - see the fetcher generation tests above.
     */
    it('should refuse to fetch on a stopped consumer', async () => {
      runner.scheduleFetchManager = jest.fn()
      await runner.start()
      runner.running = false

      await expect(runner.fetch(1)).rejects.toThrow('Consumer is not running')
      expect(consumerGroup.fetch).not.toHaveBeenCalled()
    })
  })
})

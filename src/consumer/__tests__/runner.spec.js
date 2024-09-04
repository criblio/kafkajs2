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

    it('should detect a rebalance and rejoin', async () => {
      runner.heartbeat = jest.fn().mockImplementation(async () => {
        await sleep(100)
        throw rebalancingError()
      })

      const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(300)
      })

      await runner.start()

      expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
      expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)
      expect(runner.heartbeat).toHaveBeenCalledTimes(1) // triggered along with fetchManager.start().

      await waitFor(() => consumerGroup.joinAndSync.mock.calls.length === 2, { maxWait: 200 }) // rejoin after rebalance was detected
      await waitFor(() => fetchManagerStartSpy.mock.calls.length === 2, { maxWait: 200 }) // second call to fetchManager.start() on retry
    })

    it('should detect when the consumer becomes unknown to the coordinator and rejoin', async () => {
      runner.heartbeat = jest.fn().mockImplementation(async () => {
        await sleep(100)
        throw unknownMemberError()
      })

      const fetchManagerStartSpy = jest.spyOn(runner.fetchManager, 'start')

      consumerGroup.getNodeIds = jest.fn(() => [1])
      consumerGroup.fetch = jest.fn().mockImplementation(async () => {
        await sleep(300)
      })

      await runner.start()

      expect(consumerGroup.joinAndSync).toHaveBeenCalledTimes(1)
      expect(fetchManagerStartSpy).toHaveBeenCalledTimes(1)
      expect(runner.heartbeat).toHaveBeenCalledTimes(1) // triggered along with fetchManager.start().

      await waitFor(() => consumerGroup.joinAndSync.mock.calls.length === 2, { maxWait: 200 }) // rejoin after coordinator rejects this consumer
      await waitFor(() => fetchManagerStartSpy.mock.calls.length === 2, { maxWait: 200 }) // second call to fetchManager.start() on retry
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

    it('should ignore request errors from fetch on stopped consumer', async () => {
      const rejectedRequest = () =>
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('Failed or manually rejected request')), 10)
        })

      consumerGroup.fetch
        .mockImplementationOnce(rejectedRequest)
        .mockImplementationOnce(async () => {
          await sleep(10)
          return []
        })

      runner.scheduleFetchManager = jest.fn()
      await runner.start()
      runner.running = false

      await runner.fetch()
    })
  })
})

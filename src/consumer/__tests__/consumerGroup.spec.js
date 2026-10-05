const ConsumerGroup = require('../consumerGroup')
const { newLogger } = require('testHelpers')
const { KafkaJSConnectionError } = require('../../errors')

describe('ConsumerGroup', () => {
  let consumerGroup

  beforeEach(() => {
    consumerGroup = new ConsumerGroup({
      logger: newLogger(),
      topics: ['topic1'],
      cluster: {},
    })
  })

  describe('uncommittedOffsets', () => {
    it("calls the offset manager's uncommittedOffsets", async () => {
      const mockOffsets = { topics: [] }
      consumerGroup.offsetManager = { uncommittedOffsets: jest.fn(() => mockOffsets) }

      expect(consumerGroup.uncommittedOffsets()).toStrictEqual(mockOffsets)
      expect(consumerGroup.offsetManager.uncommittedOffsets).toHaveBeenCalled()
    })
  })

  describe('joinAndSync', () => {
    it('does not send JoinGroup when shutdown starts during the coordinator lookup', async () => {
      let running = true
      const coordinator = { joinGroup: jest.fn() }
      consumerGroup.assigners = []
      consumerGroup.cluster = {
        findGroupCoordinator: jest.fn(async () => {
          running = false
          return coordinator
        }),
      }

      await expect(consumerGroup.joinAndSync({ shouldAbort: () => !running })).rejects.toThrow(
        /not running/
      )
      expect(consumerGroup.cluster.findGroupCoordinator).toHaveBeenCalledTimes(1)
      expect(coordinator.joinGroup).not.toHaveBeenCalled()
    })

    it('keeps the member id assigned before an aborted join', async () => {
      let running = true
      const coordinator = {
        joinGroup: jest.fn(async ({ onMemberIdAssigned }) => {
          onMemberIdAssigned('member-1')
          running = false
          throw new KafkaJSConnectionError('Connection aborted')
        }),
      }
      consumerGroup.assigners = []
      consumerGroup.cluster = { findGroupCoordinator: jest.fn(async () => coordinator) }

      await expect(consumerGroup.joinAndSync({ shouldAbort: () => !running })).rejects.toThrow(
        /not running/
      )
      // leave() needs this id to remove the member the broker already registered.
      expect(consumerGroup.memberId).toEqual('member-1')
    })
  })

  describe('commitOffsets', () => {
    it("calls the offset manager's commitOffsets", async () => {
      consumerGroup.offsetManager = { commitOffsets: jest.fn(() => Promise.resolve()) }

      const offsets = { topics: [{ partitions: [{ offset: '0', partition: 0 }] }] }
      await consumerGroup.commitOffsets(offsets)
      expect(consumerGroup.offsetManager.commitOffsets).toHaveBeenCalledTimes(1)
      expect(consumerGroup.offsetManager.commitOffsets).toHaveBeenCalledWith(offsets)
    })
  })
})

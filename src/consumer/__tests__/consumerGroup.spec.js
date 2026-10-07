const ConsumerGroup = require('../consumerGroup')
const { newLogger } = require('testHelpers')

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

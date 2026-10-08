const createAdmin = require('../../admin')
const createProducer = require('../../producer')
const createConsumer = require('../index')
const sleep = require('../../utils/sleep')

const {
  secureRandom,
  createCluster,
  createTopic,
  newLogger,
  waitFor,
  waitForNextEvent,
  saslConnectionOpts,
  saslBrokers,
} = require('testHelpers')

/**
 * Regression tests for consumer.stop() blocking on an in-flight rejoin.
 *
 * Consumer B blocks inside eachMessage until the test releases it, so it never rejoins.
 * The broker therefore parks the JoinGroup of every other member until rebalanceTimeout.
 * Before the fix, stop() waited for that JoinGroup; now it must return promptly and leave
 * the group.
 *
 * REBALANCING fires before the JoinGroup is sent, so stopping on that event alone only tests
 * the check that skips JoinGroup. The tests instead wait until each stopper has called
 * joinGroup on its coordinator, so the abort of an in-flight JoinGroup is what gets tested.
 *
 * Nothing here depends on how fast the broker is: B is held by a promise, not a timer,
 * and the timeouts are far longer than the tests. The only timing assertion compares
 * STOP_BOUND against REBALANCE_TIMEOUT, which differ by 3x.
 */
const SESSION_TIMEOUT = 30000
const REBALANCE_TIMEOUT = 30000
const STOP_BOUND = 10000

const variants = [{ name: 'PLAINTEXT', clusterOpts: () => [{}] }]
if (process.env['OAUTHBEARER_ENABLED'] !== '1') {
  // The stopped consumer reconnects its coordinator connection for LeaveGroup after the
  // abort, so under SASL that LeaveGroup must re-authenticate on the fresh socket.
  variants.push({ name: 'SASL PLAIN', clusterOpts: () => [saslConnectionOpts(), saslBrokers()] })
}

describe('Consumer > stop during rejoin', () => {
  for (const variant of variants) {
    describe(variant.name, () => {
      let topicName, groupId, admin, producer, consumers, releaseB

      // Counts joinGroup calls on the coordinators this cluster hands out.
      const countCoordinatorCalls = cluster => {
        const counter = { joinGroup: 0 }
        const findGroupCoordinator = cluster.findGroupCoordinator.bind(cluster)
        cluster.findGroupCoordinator = async (...args) => {
          const coordinator = await findGroupCoordinator(...args)
          if (!coordinator.callsCounted) {
            coordinator.callsCounted = true
            for (const method of Object.keys(counter)) {
              const original = coordinator[method].bind(coordinator)
              coordinator[method] = (...methodArgs) => {
                counter[method]++
                return original(...methodArgs)
              }
            }
          }
          return coordinator
        }
        return counter
      }

      const coordinatorCalls = new Map()

      const newConsumer = () => {
        const cluster = createCluster(...variant.clusterOpts())
        const counter = countCoordinatorCalls(cluster)
        const consumer = createConsumer({
          cluster,
          groupId,
          sessionTimeout: SESSION_TIMEOUT,
          rebalanceTimeout: REBALANCE_TIMEOUT,
          heartbeatInterval: 100,
          maxWaitTimeInMs: 100,
          logger: newLogger(),
        })
        consumers.push(consumer)
        coordinatorCalls.set(consumer, counter)
        return consumer
      }

      beforeEach(async () => {
        topicName = `test-topic-${secureRandom()}`
        groupId = `consumer-group-id-${secureRandom()}`
        consumers = []
        releaseB = null

        admin = createAdmin({ cluster: createCluster(), logger: newLogger() })
        producer = createProducer({ cluster: createCluster(), logger: newLogger() })
        await Promise.all([admin.connect(), producer.connect()])
      })

      afterEach(async () => {
        // Release B first so the parked rebalance can complete and every consumer can stop.
        releaseB && releaseB()
        for (const consumer of consumers) {
          await consumer.disconnect()
        }
        producer && (await producer.disconnect())
        admin && (await admin.disconnect())
      })

      const latest = joins => joins[joins.length - 1]
      const assignedPartitions = join => (join && join.memberAssignment[topicName]) || []

      const produceToEveryPartition = (partitions, count) =>
        producer.send({
          acks: 1,
          topic: topicName,
          messages: Array.from({ length: partitions * count }, (_, i) => ({
            partition: i % partitions,
            value: `value-${secureRandom()}`,
          })),
        })

      const committedOffsets = async () => {
        const [{ partitions }] = await admin.fetchOffsets({ groupId, topics: [topicName] })
        return partitions.reduce((acc, { partition, offset }) => {
          acc[partition] = Number(offset)
          return acc
        }, {})
      }

      // Waits until the latest generation gives each member exactly one partition.
      const waitForOnePartitionEach = (members, joins, partitions) =>
        waitFor(
          () => {
            const owned = members.map(m => assignedPartitions(latest(joins.get(m))))
            const all = [].concat(...owned)
            return (
              owned.every(p => p.length === 1) &&
              new Set(all).size === partitions &&
              all.length === partitions
            )
          },
          {
            maxWait: 20000,
            ignoreTimeout: false,
            timeoutMessage: 'members did not settle on one partition each',
          }
        )

      // B's eachMessage: records the message, then waits until the test calls releaseB.
      const blockUntilReleased = record => {
        const released = new Promise(resolve => {
          releaseB = resolve
        })
        let markBlocked
        const blocked = new Promise(resolve => {
          markBlocked = resolve
        })
        const eachMessage = async payload => {
          record(payload)
          markBlocked()
          await released
        }
        return { blocked, eachMessage }
      }

      const recordInto = consumed => member => ({ partition, message }) =>
        consumed.push({ member, partition, offset: Number(message.offset) })

      const waitForAllConsumed = (consumed, partitions, total, maxWait = 60000) => {
        const key = m => `${m.partition}:${m.offset}`
        return waitFor(() => new Set(consumed.map(key)).size === partitions * total, {
          maxWait,
          ignoreTimeout: false,
          timeoutMessage: 'the remaining members did not consume every message',
        })
      }

      /**
       * Starts `stopperCount` consumers plus the blocked consumer B, one partition each,
       * then has consumer C join so that every stopper's rejoin is parked behind B.
       * Every stopper has committed its partition before the rebalance starts.
       */
      const parkRejoins = async ({ stopperCount }) => {
        const partitions = stopperCount + 1
        await createTopic({ topic: topicName, partitions })

        const stoppers = Array.from({ length: stopperCount }, () => newConsumer())
        const consumerB = newConsumer()
        const consumerC = newConsumer()

        const joins = new Map()
        const crashes = []
        // Every message any member processed, for checking loss and duplication later.
        const consumed = []
        for (const consumer of [...stoppers, consumerB]) {
          joins.set(consumer, [])
          consumer.on(consumer.events.GROUP_JOIN, e => joins.get(consumer).push(e.payload))
        }
        for (const consumer of stoppers) {
          consumer.on(consumer.events.CRASH, e => crashes.push(e.payload.error))
        }

        for (const consumer of [...stoppers, consumerB]) {
          await consumer.connect()
          await consumer.subscribe({ topic: topicName, fromBeginning: true })
        }

        const record = recordInto(consumed)
        const gate = blockUntilReleased(record('B'))

        for (const [index, consumer] of stoppers.entries()) {
          await consumer.run({ eachMessage: async payload => record(index)(payload) })
        }
        await consumerB.run({ eachMessage: gate.eachMessage })

        // A stopper may join alone first and then rejoin when the others arrive.
        await waitForOnePartitionEach([...stoppers, consumerB], joins, partitions)
        const memberIds = stoppers.map(c => latest(joins.get(c)).memberId)
        const stopperPartitions = stoppers.map(c => assignedPartitions(latest(joins.get(c)))[0])

        await produceToEveryPartition(partitions, 1)
        await gate.blocked
        await waitFor(
          () =>
            stopperPartitions.every(p => consumed.some(m => m.member !== 'B' && m.partition === p)),
          { maxWait: 20000, ignoreTimeout: false, timeoutMessage: 'stoppers did not consume' }
        )

        // Commit before the rebalance, so the offset check after stop() is not racing
        // an ordinary auto-commit.
        await waitFor(
          async () => {
            const offsets = await committedOffsets()
            return stopperPartitions.every(p => offsets[p] === 1)
          },
          {
            delay: 200,
            maxWait: 20000,
            ignoreTimeout: false,
            timeoutMessage: 'stoppers did not commit their partitions',
          }
        )

        // C joining starts a rebalance. Each stopper rejoins and the broker holds its
        // JoinGroup, because B cannot rejoin while it is blocked.
        const rebalancing = stoppers.map(c =>
          waitForNextEvent(c, c.events.REBALANCING, { maxWait: 20000 })
        )
        const callsBeforeRebalance = stoppers.map(c => coordinatorCalls.get(c).joinGroup)
        await consumerC.connect()
        await consumerC.subscribe({ topic: topicName, fromBeginning: true })
        // Not awaited: run() resolves only after C's own join, which is parked behind B too.
        // Awaiting it would sit out rebalanceTimeout and let the stoppers' joins finish first.
        consumerC.run({ eachMessage: async payload => record('C')(payload) }).catch(() => {})
        await Promise.all(rebalancing)
        await waitFor(
          () =>
            stoppers.every((c, i) => coordinatorCalls.get(c).joinGroup > callsBeforeRebalance[i]),
          {
            maxWait: 20000,
            ignoreTimeout: false,
            timeoutMessage: 'stoppers did not send their rejoin JoinGroup',
          }
        )

        return { partitions, stoppers, joins, crashes, consumed, memberIds, stopperPartitions }
      }

      const stopWithinBound = stoppers => {
        const stopped = Promise.all(stoppers.map(c => c.stop())).then(() => 'stopped')
        return Promise.race([stopped, sleep(STOP_BOUND).then(() => 'timeout')])
      }

      const groupMemberIds = async () => {
        const {
          groups: [group],
        } = await admin.describeGroups([groupId])
        return group.members.map(m => m.memberId)
      }

      test('stop() returns promptly and leaves the group while JoinGroup is parked', async () => {
        const {
          stoppers: [consumerA],
          joins,
          crashes,
          memberIds: [memberIdA],
        } = await parkRejoins({ stopperCount: 1 })

        // Guard against a vacuous pass: A's rejoin must still be parked when stop() starts.
        const joinsBeforeStop = joins.get(consumerA).length

        expect(await stopWithinBound([consumerA])).toEqual('stopped')
        expect(joins.get(consumerA).length).toEqual(joinsBeforeStop)
        expect(await groupMemberIds()).not.toContain(memberIdA)
        expect(crashes).toEqual([])
      })

      test('several members stop together while their JoinGroups are parked', async () => {
        const { stoppers, joins, crashes, memberIds } = await parkRejoins({ stopperCount: 3 })
        const joinsBeforeStop = stoppers.map(c => joins.get(c).length)

        expect(await stopWithinBound(stoppers)).toEqual('stopped')
        expect(stoppers.map(c => joins.get(c).length)).toEqual(joinsBeforeStop)
        const remaining = await groupMemberIds()
        for (const memberId of memberIds) {
          expect(remaining).not.toContain(memberId)
        }
        expect(crashes).toEqual([])
      })

      test('the whole group stops at once', async () => {
        // Each LeaveGroup starts a rebalance for the members that are still stopping,
        // so their stop() races REBALANCE_IN_PROGRESS without any member being blocked.
        const partitions = 4
        await createTopic({ topic: topicName, partitions })
        const members = Array.from({ length: partitions }, () => newConsumer())
        const joins = new Map()
        const crashes = []
        for (const consumer of members) {
          joins.set(consumer, [])
          consumer.on(consumer.events.GROUP_JOIN, e => joins.get(consumer).push(e.payload))
          consumer.on(consumer.events.CRASH, e => crashes.push(e.payload.error))
          await consumer.connect()
          await consumer.subscribe({ topic: topicName, fromBeginning: true })
        }
        for (const consumer of members) {
          await consumer.run({ eachMessage: async () => {} })
        }
        await waitForOnePartitionEach(members, joins, partitions)

        expect(await stopWithinBound(members)).toEqual('stopped')
        expect(await groupMemberIds()).toEqual([])
        expect(crashes).toEqual([])
      })

      /**
       * Produces more messages, releases B and lets B and C take over every partition,
       * including the stopped member's. Then checks that nothing was lost anywhere and that
       * the stopped member's partition was processed exactly once per offset, which holds
       * only if the new owner resumed at the stopped member's committed offset.
       */
      const expectHandoverWithoutLossOrDuplicates = async ({ consumed, partitions, partition }) => {
        const messagesAfterStop = 5
        await produceToEveryPartition(partitions, messagesAfterStop)
        releaseB()

        const total = 1 + messagesAfterStop
        await waitForAllConsumed(consumed, partitions, total)

        const seen = new Set(consumed.map(m => `${m.partition}:${m.offset}`))
        for (let p = 0; p < partitions; p++) {
          for (let offset = 0; offset < total; offset++) {
            expect(seen).toContain(`${p}:${offset}`)
          }
        }

        // B's own partition is excluded, because B's commit after release can fail on a
        // stale generation and its message is legitimately redelivered (at-least-once).
        const offsets = consumed.filter(m => m.partition === partition).map(m => m.offset)
        expect(offsets.sort((a, b) => a - b)).toEqual(Array.from({ length: total }, (_, i) => i))
      }

      test('offsets survive a stop during rejoin, with no loss and no duplicates', async () => {
        const {
          partitions,
          stoppers: [consumerA],
          crashes,
          consumed,
          stopperPartitions: [partitionA],
        } = await parkRejoins({ stopperCount: 1 })

        expect(await stopWithinBound([consumerA])).toEqual('stopped')

        // Everything A processed is still committed after the stop, including the abort.
        const consumedByA = consumed.filter(m => m.member === 0 && m.partition === partitionA)
        const lastOffsetA = Math.max(...consumedByA.map(m => m.offset))
        expect((await committedOffsets())[partitionA]).toEqual(lastOffsetA + 1)

        await expectHandoverWithoutLossOrDuplicates({ consumed, partitions, partition: partitionA })
        expect(crashes).toEqual([])
      })
    })
  }
})

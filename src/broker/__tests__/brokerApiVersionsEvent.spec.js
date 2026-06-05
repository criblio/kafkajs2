const { newLogger } = require('testHelpers')

const InstrumentationEventEmitter = require('../../instrumentation/emitter')
const { KafkaJSNonRetriableError } = require('../../errors')
const Broker = require('../index')
const { BROKER_API_VERSIONS } = require('../instrumentationEvents')

/**
 * Unit coverage for the BROKER_API_VERSIONS instrumentation event.
 *
 * These tests exercise the real Broker#connect() guard logic but mock the
 * network boundary (connectionPool) and the wire response (apiVersions), so
 * they run without a live Kafka broker and stay deterministic. The focus is
 * non-happy paths: failures, opt-out, reconnects, and misbehaving listeners
 * must not change the connection flow.
 */
describe('Broker > BROKER_API_VERSIONS event', () => {
  const VERSIONS = {
    0: { minVersion: 0, maxVersion: 9 },
    18: { minVersion: 0, maxVersion: 3 },
  }

  let connectionPool, authenticate, setVersions, emitter

  const createFakeConnectionPool = () => {
    authenticate = jest.fn(async () => {})
    setVersions = jest.fn()
    const connection = {
      // Non-null return skips the SaslAuthenticate lookup block in connect()
      getSupportAuthenticationProtocol: () => true,
      authenticate,
    }
    return {
      host: 'kafka.test',
      port: 9092,
      clientId: 'test-client',
      connectionTimeout: 1000,
      sasl: null,
      isConnected: jest.fn(() => false),
      isAuthenticated: jest.fn(() => false),
      getConnection: jest.fn(async () => connection),
      setVersions,
    }
  }

  beforeEach(() => {
    connectionPool = createFakeConnectionPool()
    emitter = new InstrumentationEventEmitter()
  })

  test('emits exactly once with the broker fingerprint on a successful connect', async () => {
    const broker = new Broker({
      connectionPool,
      logger: newLogger(),
      nodeId: 7,
      instrumentationEmitter: emitter,
    })
    const apiVersionsSpy = jest.spyOn(broker, 'apiVersions').mockResolvedValue(VERSIONS)
    const listener = jest.fn()
    emitter.addListener(BROKER_API_VERSIONS, listener)

    await broker.connect()

    expect(apiVersionsSpy).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].payload).toEqual({
      broker: 'kafka.test:9092',
      nodeId: 7,
      clientId: 'test-client',
      apiVersions: VERSIONS,
    })
    expect(setVersions).toHaveBeenCalledWith(VERSIONS)
  })

  test('emits a deep copy: mutating the payload at any layer does not corrupt the live versions', async () => {
    // A fresh live object plus an independent pristine snapshot to compare against.
    // Using the shared VERSIONS const would make the "original unmutated" assertion
    // compare the object to itself, which cannot catch a leaked reference.
    const liveVersions = {
      0: { minVersion: 0, maxVersion: 9 },
      18: { minVersion: 0, maxVersion: 3 },
    }
    const pristine = {
      0: { minVersion: 0, maxVersion: 9 },
      18: { minVersion: 0, maxVersion: 3 },
    }

    const broker = new Broker({
      connectionPool,
      logger: newLogger(),
      nodeId: 7,
      instrumentationEmitter: emitter,
    })
    jest.spyOn(broker, 'apiVersions').mockResolvedValue(liveVersions)
    let payload
    emitter.addListener(BROKER_API_VERSIONS, event => {
      payload = event.payload
    })

    await broker.connect()

    // The emitted apiVersions is a distinct object graph at every layer, not the live object.
    expect(payload.apiVersions).not.toBe(liveVersions)
    expect(payload.apiVersions[18]).not.toBe(liveVersions[18])

    // Mutate the emitted payload at both the top layer (add/remove keys) and the
    // nested layer (change a version range).
    payload.apiVersions[42] = { minVersion: 0, maxVersion: 0 }
    delete payload.apiVersions[0]
    payload.apiVersions[18].maxVersion = 999

    // The broker still holds the original object, and that object is untouched -- so the
    // setVersions()/lookup() calls that ran on the same reference saw uncorrupted data.
    expect(broker.versions).toBe(liveVersions)
    expect(broker.versions).toEqual(pristine)
    expect(setVersions).toHaveBeenCalledWith(pristine)
  })

  test('does not emit when api version negotiation fails, and surfaces the error', async () => {
    const broker = new Broker({
      connectionPool,
      logger: newLogger(),
      instrumentationEmitter: emitter,
    })
    jest
      .spyOn(broker, 'apiVersions')
      .mockRejectedValue(new KafkaJSNonRetriableError('API Versions not supported'))
    const listener = jest.fn()
    emitter.addListener(BROKER_API_VERSIONS, listener)

    await expect(broker.connect()).rejects.toThrow('API Versions not supported')

    expect(listener).not.toHaveBeenCalled()
    expect(setVersions).not.toHaveBeenCalled()
    expect(broker.versions).toEqual(null)
  })

  test('does not emit or re-negotiate when versions are already provided (non-seed broker)', async () => {
    const broker = new Broker({
      connectionPool,
      logger: newLogger(),
      nodeId: 2,
      versions: VERSIONS,
      instrumentationEmitter: emitter,
    })
    const apiVersionsSpy = jest.spyOn(broker, 'apiVersions')
    const listener = jest.fn()
    emitter.addListener(BROKER_API_VERSIONS, listener)

    await broker.connect()

    expect(apiVersionsSpy).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(setVersions).toHaveBeenCalledWith(VERSIONS)
  })

  test('connects successfully when no instrumentationEmitter is provided', async () => {
    const broker = new Broker({ connectionPool, logger: newLogger() })
    jest.spyOn(broker, 'apiVersions').mockResolvedValue(VERSIONS)

    await expect(broker.connect()).resolves.toBeUndefined()

    expect(setVersions).toHaveBeenCalledWith(VERSIONS)
    expect(authenticate).toHaveBeenCalledTimes(1)
  })

  test('emits only once across repeated connect calls (no duplicate telemetry on reconnect)', async () => {
    const broker = new Broker({
      connectionPool,
      logger: newLogger(),
      instrumentationEmitter: emitter,
    })
    const apiVersionsSpy = jest.spyOn(broker, 'apiVersions').mockResolvedValue(VERSIONS)
    const listener = jest.fn()
    emitter.addListener(BROKER_API_VERSIONS, listener)

    await broker.connect()
    await broker.connect()

    expect(apiVersionsSpy).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(setVersions).toHaveBeenCalledTimes(2)
  })

  test('a throwing listener does not break the connection flow', async () => {
    const broker = new Broker({
      connectionPool,
      logger: newLogger(),
      instrumentationEmitter: emitter,
    })
    jest.spyOn(broker, 'apiVersions').mockResolvedValue(VERSIONS)
    emitter.addListener(BROKER_API_VERSIONS, () => {
      throw new Error('subscriber blew up')
    })

    await expect(broker.connect()).resolves.toBeUndefined()

    expect(setVersions).toHaveBeenCalledWith(VERSIONS)
    expect(authenticate).toHaveBeenCalledTimes(1)
  })
})

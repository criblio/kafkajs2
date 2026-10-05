const { connectionOpts, sslConnectionOpts } = require('../../testHelpers')
const sleep = require('../utils/sleep')
const { requests } = require('../protocol/requests')
const Decoder = require('../protocol/decoder')
const Encoder = require('../protocol/encoder')
const { KafkaJSRequestTimeoutError, KafkaJSConnectionError } = require('../errors')
const waitFor = require('../utils/waitFor')
const Connection = require('./connection')
const { CONNECTION_STATUS } = require('./connectionStatus')
const EventEmitter = require('events')

describe('Network > Connection', () => {
  const invalidHost = 'kafkajs.test'
  let connection

  afterEach(async () => {
    connection && (await connection.disconnect())
  })

  // Sockets that connect only when the test calls their onConnect callback.
  const manualSockets = () => {
    const sockets = []
    const connectCallbacks = []
    const socketFactory = ({ onConnect }) => {
      const socket = new EventEmitter()
      socket.write = jest.fn()
      socket.end = jest.fn()
      socket.destroy = jest.fn()
      socket.unref = jest.fn()
      sockets.push(socket)
      connectCallbacks.push(onConnect)
      return socket
    }
    return { sockets, connectCallbacks, socketFactory }
  }

  // Emits every event the connection listens for, as a socket might after it is closed.
  const emitLateEvents = async socket => {
    socket.emit('data', Buffer.from([0, 0, 0, 8, 1, 2]))
    socket.emit('timeout')
    socket.emit('error', new Error('late error'))
    socket.emit('end')
    await new Promise(resolve => setImmediate(resolve))
  }

  // Checks that late events from a closed socket leave the reconnected `connection`, and a
  // request in flight on it, untouched. Fails that request afterwards so afterEach's
  // disconnect() does not wait on it.
  const expectLateEventsIgnored = async (closedSocket, currentSocket) => {
    const apiVersions = requests.ApiVersions.protocol({ version: 0 })
    let settled = false
    const pending = connection.send(apiVersions())
    pending.then(
      () => (settled = true),
      () => (settled = true)
    )
    await waitFor(() => connection.requestQueue.inflight.size > 0)

    await emitLateEvents(closedSocket)

    expect(connection.isConnected()).toEqual(true)
    expect(connection.socket).toBe(currentSocket)
    expect(currentSocket.end).not.toHaveBeenCalled()
    expect(connection.bytesBuffered).toEqual(0)
    expect(settled).toEqual(false)

    connection.abort()
    await pending.catch(() => {})
  }

  describe('#connect', () => {
    describe('PLAINTEXT', () => {
      beforeEach(() => {
        connection = new Connection(connectionOpts())
      })

      test('resolves the Promise when connected', async () => {
        await expect(connection.connect()).resolves.toEqual(true)
        expect(connection.isConnected()).toEqual(true)
      })

      test('rejects the Promise in case of errors', async () => {
        connection.host = invalidHost
        const messagePattern = /Connection error: getaddrinfo ENOTFOUND kafkajs.test/
        await expect(connection.connect()).rejects.toThrow(messagePattern)
        expect(connection.isConnected()).toEqual(false)
      })
    })

    describe('SSL', () => {
      beforeEach(() => {
        connection = new Connection(sslConnectionOpts())
      })

      test('resolves the Promise when connected', async () => {
        await expect(connection.connect()).resolves.toEqual(true)
        expect(connection.isConnected()).toEqual(true)
      })

      test('rejects the Promise in case of timeouts', async () => {
        const socketFactory = () => {
          const socket = new EventEmitter()
          socket.end = () => {}
          socket.unref = () => {}
          return socket
        }
        connection = new Connection({
          ...sslConnectionOpts({ connectionTimeout: 1 }),
          socketFactory,
        })

        await expect(connection.connect()).rejects.toHaveProperty('message', 'Connection timeout')
        expect(connection.isConnected()).toEqual(false)
      })

      test('rejects the Promise in case of errors', async () => {
        connection.ssl.cert = 'invalid'
        const messagePattern = /Failed to connect/
        await expect(connection.connect()).rejects.toThrow(messagePattern)
        expect(connection.isConnected()).toEqual(false)
      })

      test('sets the authenticatedAt timer', async () => {
        connection.authenticatedAt = process.hrtime()
        await connection.connect()
        expect(connection.authenticatedAt).toBe(null)
      })
    })
  })

  describe('#disconnect', () => {
    beforeEach(() => {
      connection = new Connection(connectionOpts())
    })

    describe('followed by a reconnect', () => {
      let sockets, connectCallbacks

      beforeEach(() => {
        let socketFactory
        ;({ sockets, connectCallbacks, socketFactory } = manualSockets())
        connection = new Connection(connectionOpts({ socketFactory }))
      })

      test('ignores late events from the disconnected socket', async () => {
        const connecting = connection.connect()
        connectCallbacks[0]()
        await connecting
        await connection.disconnect()

        const reconnecting = connection.connect()
        connectCallbacks[1]()
        await reconnecting

        await expectLateEventsIgnored(sockets[0], sockets[1])
      })

      test('does not leave a connect in progress hanging', async () => {
        let settled = false
        connection
          .connect()
          .catch(() => {})
          .then(() => (settled = true))
        await connection.disconnect()

        // The socket's own connect callback must still settle the connect.
        connectCallbacks[0]()
        await waitFor(() => settled, { maxWait: 1000, ignoreTimeout: false })
      })
    })

    test('disconnects an active connection', async () => {
      await connection.connect()
      expect(connection.isConnected()).toEqual(true)
      await expect(connection.disconnect()).resolves.toEqual(true)
      expect(connection.isConnected()).toEqual(false)
    })

    test('trigger "end" and "unref" function on not active connection', async () => {
      expect(connection.isConnected()).toEqual(false)
      connection.socket = {
        end: jest.fn(),
        unref: jest.fn(),
      }
      await expect(connection.disconnect()).resolves.toEqual(true)
      expect(connection.socket.end).toHaveBeenCalled()
      expect(connection.socket.unref).toHaveBeenCalled()
    })

    test(`clean up connection's internal state on disconnect`, async () => {
      connection = new Connection(
        connectionOpts({
          requestTimeout: 50,
          enforceRequestTimeout: true,
        })
      )

      expect(connection.bytesBuffered).toEqual(0)
      expect(connection.bytesNeeded).toEqual(Decoder.int32Size())
      expect(connection.chunks.length).toEqual(0)
      expect(connection.correlationId).toEqual(0)

      const originalProcessData = connection.processData
      let partialData, remainderBuffer
      connection.processData = async data => {
        partialData = data.subarray(0, 4)
        remainderBuffer = data.subarray(4)
        originalProcessData.apply(connection, [partialData])
      }

      const apiVersions = requests.ApiVersions.protocol({ version: 0 })

      await connection.connect()
      expect(connection.connectionStatus).toEqual(CONNECTION_STATUS.CONNECTED)
      await expect(connection.send(apiVersions())).rejects.toThrowError(KafkaJSRequestTimeoutError)

      expect(connection.bytesBuffered).toEqual(partialData.length)
      expect(connection.bytesNeeded).toEqual(Decoder.int32Size() + remainderBuffer.length)
      expect(connection.chunks.length).toEqual(1)
      expect(connection.chunks[0]).toEqual(partialData)
      expect(connection.correlationId).toEqual(1)

      await connection.disconnect()
      expect(connection.connectionStatus).toEqual(CONNECTION_STATUS.DISCONNECTED)
      expect(connection.bytesBuffered).toEqual(0)
      expect(connection.bytesNeeded).toEqual(Decoder.int32Size())
      expect(connection.chunks.length).toEqual(0)
      expect(connection.correlationId).toEqual(0)

      await sleep(20)

      connection.processData = originalProcessData
      connection.requestQueue.enforceRequestTimeout = false

      await connection.connect()
      await connection.send(apiVersions())
      await connection.disconnect()

      expect(connection.connectionStatus).toEqual(CONNECTION_STATUS.DISCONNECTED)
      expect(connection.bytesBuffered).toEqual(0)
      expect(connection.bytesNeeded).toEqual(Decoder.int32Size())
      expect(connection.chunks.length).toEqual(0)
      expect(connection.correlationId).toEqual(0)
    })
  })

  describe('#send', () => {
    let apiVersions, metadata

    beforeEach(() => {
      connection = new Connection(connectionOpts())
      apiVersions = requests.ApiVersions.protocol({ version: 0 })
      metadata = requests.Metadata.protocol({ version: 0 })
    })

    test('resolves the Promise with the response', async () => {
      await connection.connect()
      await expect(connection.send(apiVersions())).resolves.toBeTruthy()
    })

    test('rejects the Promise if it is not connected', async () => {
      expect(connection.isConnected()).toEqual(false)
      await expect(connection.send(apiVersions())).rejects.toEqual(new Error('Not connected'))
    })

    test('rejects the Promise in case of a non-retriable error', async () => {
      const protocol = {
        ...apiVersions(),
        response: {
          ...apiVersions().response,
          parse: () => {
            throw new Error('non-retriable')
          },
        },
      }

      await connection.connect()
      await expect(connection.send(protocol)).rejects.toEqual(new Error('non-retriable'))
    })

    test('respect the maxInFlightRequests', async () => {
      const protocol = apiVersions()
      connection = new Connection(connectionOpts({ maxInFlightRequests: 2 }))
      const originalProcessData = connection.processData

      connection.processData = async data => {
        await sleep(100)
        originalProcessData.apply(connection, [data])
      }

      await connection.connect()

      const requests = [
        connection.send(protocol),
        connection.send(protocol),
        connection.send(protocol),
      ]

      await sleep(50)

      const inFlightRequestsSize = connection.requestQueue.inflight.size
      const pendingRequestsSize = connection.requestQueue.pending.length

      await Promise.all(requests)

      expect(inFlightRequestsSize).toEqual(2)
      expect(pendingRequestsSize).toEqual(1)
    })

    test('respect the requestTimeout', async () => {
      const protocol = apiVersions()
      connection = new Connection(
        connectionOpts({
          requestTimeout: 50,
          enforceRequestTimeout: true,
        })
      )
      const originalProcessData = connection.processData
      // The delayed response lands after this test ends, when later tests have reassigned the
      // shared `connection`. Capture this test's instance so the late data is not fed to theirs.
      const timedOutConnection = connection

      timedOutConnection.processData = async data => {
        await sleep(100)
        originalProcessData.apply(timedOutConnection, [data])
      }

      await connection.connect()
      await expect(connection.send(protocol)).rejects.toThrowError(KafkaJSRequestTimeoutError)
    })

    test('throttles the request queue', async () => {
      const clientSideThrottleTime = 500
      // Create a fictitious request with a response that indicates client-side throttling is needed
      const protocol = {
        request: {
          apiKey: -1,
          apiVersion: 0,
          expectResponse: () => true,
          encode: () => new Encoder(),
        },
        response: {
          decode: () => ({ clientSideThrottleTime }),
          parse: () => ({}),
        },
      }

      // Setup the socket connection to accept the request
      const correlationId = 383
      connection.nextCorrelationId = () => correlationId
      connection.connectionStatus = CONNECTION_STATUS.CONNECTED
      connection.socket = {
        write() {
          // Simulate a happy response
          setImmediate(() => {
            connection.requestQueue.fulfillRequest({ correlationId, size: 0, payload: null })
          })
        },
        end() {},
        unref() {},
      }
      const before = Date.now()
      await connection.send(protocol)
      expect(connection.requestQueue.throttledUntil).toBeGreaterThanOrEqual(
        before + clientSideThrottleTime
      )
    })

    describe('Debug logging', () => {
      let initialValue, connection

      beforeAll(() => {
        initialValue = process.env.KAFKAJS_DEBUG_PROTOCOL_BUFFERS
      })

      afterAll(() => {
        process.env['KAFKAJS_DEBUG_PROTOCOL_BUFFERS'] = initialValue
      })

      afterEach(async () => {
        connection && (await connection.disconnect())
      })

      test('logs the full payload in case of non-retriable error when "KAFKAJS_DEBUG_PROTOCOL_BUFFERS" runtime flag is set', async () => {
        process.env['KAFKAJS_DEBUG_PROTOCOL_BUFFERS'] = '1'
        connection = new Connection(connectionOpts())
        const debugStub = jest.fn()
        connection.logger.debug = debugStub
        const protocol = apiVersions()
        protocol.response.parse = () => {
          throw new Error('non-retriable')
        }
        await connection.connect()
        await expect(connection.send(protocol)).rejects.toBeTruthy()

        const lastCall = debugStub.mock.calls[debugStub.mock.calls.length - 1]
        expect(lastCall[1].payload).toEqual(expect.any(Buffer))
      })

      test('filters payload in case of non-retriable error when "KAFKAJS_DEBUG_PROTOCOL_BUFFERS" runtime flag is not set', async () => {
        delete process.env['KAFKAJS_DEBUG_PROTOCOL_BUFFERS']
        connection = new Connection(connectionOpts())
        const debugStub = jest.fn()
        connection.logger.debug = debugStub
        const protocol = apiVersions()
        protocol.response.parse = () => {
          throw new Error('non-retriable')
        }
        await connection.connect()
        await expect(connection.send(protocol)).rejects.toBeTruthy()

        const lastCall = debugStub.mock.calls[debugStub.mock.calls.length - 1]
        expect(lastCall[1].payload).toEqual({
          type: 'Buffer',
          data: '[filtered]',
        })
      })
    })

    describe('Error logging', () => {
      let connection, errorStub

      beforeEach(() => {
        connection = new Connection(connectionOpts())
        errorStub = jest.fn()
        connection.logger.error = errorStub
      })

      afterEach(async () => {
        connection && (await connection.disconnect())
      })

      it('logs error responses by default', async () => {
        const protocol = metadata({ topics: [] })
        protocol.response.parse = () => {
          throw new Error('non-retriable')
        }

        expect(protocol.logResponseError).not.toBe(false)

        await connection.connect()

        await expect(connection.send(protocol)).rejects.toBeTruthy()

        expect(errorStub).toHaveBeenCalled()
      })

      it('does not log errors when protocol.logResponseError=false', async () => {
        const protocol = metadata({ topics: [] })
        protocol.response.parse = () => {
          throw new Error('non-retriable')
        }
        protocol.logResponseError = false
        await connection.connect()

        await expect(connection.send(protocol)).rejects.toBeTruthy()

        expect(errorStub).not.toHaveBeenCalled()
      })
    })
  })

  describe('#abort', () => {
    const fakeSocketFactory = () => ({ onConnect }) => {
      const socket = new EventEmitter()
      socket.write = jest.fn()
      socket.end = jest.fn()
      socket.destroy = jest.fn()
      socket.unref = jest.fn()
      setImmediate(onConnect)
      return socket
    }

    beforeEach(async () => {
      connection = new Connection(connectionOpts({ socketFactory: fakeSocketFactory() }))
      await connection.connect()
    })

    test('fails queued requests with an error the broker does not treat as closed', async () => {
      const apiVersions = requests.ApiVersions.protocol({ version: 0 })
      const pending = connection.send(apiVersions())
      await waitFor(() => connection.requestQueue.inflight.size > 0)

      connection.abort()

      const error = await pending.catch(e => e)
      expect(error).toBeInstanceOf(KafkaJSConnectionError)
      expect(error.name).toEqual('KafkaJSConnectionError')
      expect(connection.connectionStatus).toEqual(CONNECTION_STATUS.DISCONNECTED)
    })

    test('fails a pending SASL exchange that is not in the request queue', async () => {
      const authRequest = connection.sendAuthRequest({
        request: { encode: async () => Buffer.from([]) },
      })
      await waitFor(() => connection.socket.write.mock.calls.length > 0)
      expect(connection.authHandlers).not.toBeNull()

      connection.abort()

      await expect(authRequest).rejects.toBeInstanceOf(KafkaJSConnectionError)
      expect(connection.authHandlers).toBeNull()
    })

    test('leaves the connection ready to reconnect', async () => {
      connection.abort()

      await expect(connection.connect()).resolves.toEqual(true)
      expect(connection.isConnected()).toEqual(true)
    })

    describe('while connecting', () => {
      let sockets, connectCallbacks

      beforeEach(() => {
        let socketFactory
        ;({ sockets, connectCallbacks, socketFactory } = manualSockets())
        connection = new Connection(connectionOpts({ socketFactory }))
      })

      test('rejects the pending connect and destroys the socket', async () => {
        const connecting = connection.connect()

        connection.abort()

        const error = await connecting.catch(e => e)
        expect(error).toBeInstanceOf(KafkaJSConnectionError)
        expect(error.name).toEqual('KafkaJSConnectionError')
        expect(sockets[0].destroy).toHaveBeenCalled()
        expect(connection.connectionStatus).toEqual(CONNECTION_STATUS.DISCONNECTED)
      })

      test('never sends a request that was waiting on the connect', async () => {
        const apiVersions = requests.ApiVersions.protocol({ version: 0 })
        const pending = connection.connect().then(() => connection.send(apiVersions()))

        connection.abort()
        // A late connect callback from the destroyed socket must not revive the connection.
        connectCallbacks[0]()

        await expect(pending).rejects.toBeInstanceOf(KafkaJSConnectionError)
        expect(sockets[0].write).not.toHaveBeenCalled()
        expect(connection.isConnected()).toEqual(false)
      })

      test('leaves the connection ready to reconnect', async () => {
        const connecting = connection.connect().catch(e => e)
        connection.abort()
        await connecting

        const reconnecting = connection.connect()
        connectCallbacks[1]()

        await expect(reconnecting).resolves.toEqual(true)
        expect(connection.isConnected()).toEqual(true)
      })
    })

    describe('after a reconnect', () => {
      let sockets, connectCallbacks

      beforeEach(() => {
        let socketFactory
        ;({ sockets, connectCallbacks, socketFactory } = manualSockets())
        connection = new Connection(connectionOpts({ socketFactory }))
      })

      test.each([
        [
          'while connected',
          async () => {
            const connecting = connection.connect()
            connectCallbacks[0]()
            await connecting
          },
        ],
        [
          'while connecting',
          async () => {
            connection.connect().catch(() => {})
          },
        ],
      ])('ignores late events from a socket aborted %s', async (_, openFirstSocket) => {
        await openFirstSocket()
        connection.abort()

        const reconnecting = connection.connect()
        connectCallbacks[1]()
        await reconnecting

        await expectLateEventsIgnored(sockets[0], sockets[1])
      })
    })
  })

  describe('#nextCorrelationId', () => {
    beforeEach(() => {
      connection = new Connection(connectionOpts())
    })

    test('increments the current correlationId', () => {
      const id1 = connection.nextCorrelationId()
      const id2 = connection.nextCorrelationId()
      expect(id1).toEqual(0)
      expect(id2).toEqual(1)
      expect(connection.correlationId).toEqual(2)
    })

    test('resets to 0 when correlationId is equal to max signed int32', () => {
      expect(connection.correlationId).toEqual(0)

      connection.nextCorrelationId()
      connection.nextCorrelationId()
      expect(connection.correlationId).toEqual(2)

      connection.correlationId = Math.pow(2, 31) - 1
      const id1 = connection.nextCorrelationId()
      expect(id1).toEqual(0)
      expect(connection.correlationId).toEqual(1)
    })
  })

  describe('#processData', () => {
    beforeEach(() => {
      connection = new Connection(connectionOpts())
    })

    test('buffer data while it is not complete', () => {
      const correlationId = 1
      const resolve = jest.fn()
      const entry = { correlationId, resolve }

      connection.requestQueue.push({
        entry,
        expectResponse: true,
        sendRequest: jest.fn(),
      })

      const payload = Buffer.from('ab')
      const size = Buffer.byteLength(payload) + Decoder.int32Size()
      // expected response size
      const sizePart1 = Buffer.from([0, 0])
      const sizePart2 = Buffer.from([0, 6])

      const correlationIdPart1 = Buffer.from([0, 0])
      const correlationIdPart2 = Buffer.from([0])
      const correlationIdPart3 = Buffer.from([1])

      // write half of the expected size and expect to keep buffering
      expect(connection.processData(sizePart1)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // Write the rest of the size, but without any response
      expect(connection.processData(sizePart2)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // Response consists of correlation id + payload
      // Writing 1/3 of the correlation id
      expect(connection.processData(correlationIdPart1)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // At this point, we will write N bytes, where N == size,
      // but we should keep buffering because the size field should
      // not be considered as part of the response payload
      expect(connection.processData(correlationIdPart2)).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()

      // write full payload size
      const buffer = Buffer.concat([correlationIdPart3, payload])
      connection.processData(buffer)

      expect(resolve).toHaveBeenCalledWith({
        correlationId,
        size,
        entry,
        payload,
      })
    })
  })
})

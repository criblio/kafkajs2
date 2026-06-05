const { BROKER_API_VERSIONS } = require('../instrumentationEvents')
const consumerEvents = require('../../consumer/instrumentationEvents')
const producerEvents = require('../../producer/instrumentationEvents')
const adminEvents = require('../../admin/instrumentationEvents')

/**
 * The broker emits the raw BROKER_API_VERSIONS event name, but subscribers
 * listen via the namespaced alias (e.g. consumer.events.BROKER_API_VERSIONS).
 * The wrap/unwrap mapping is what bridges the two -- consumer.on() unwraps the
 * namespaced name down to the raw broker name to register the listener, then
 * re-wraps event.type before handing it back. If the wrappedEvents entry is
 * dropped, the listener silently never fires. These tests guard that bridge.
 */
describe('broker api versions event wiring', () => {
  const cases = [
    ['consumer', consumerEvents, 'consumer.broker.api_versions'],
    ['producer', producerEvents, 'producer.broker.api_versions'],
    ['admin', adminEvents, 'admin.broker.api_versions'],
  ]

  for (const [name, mod, namespaced] of cases) {
    describe(name, () => {
      test('exposes the namespaced event alias', () => {
        expect(mod.events.BROKER_API_VERSIONS).toEqual(namespaced)
      })

      test('unwraps the alias to the raw broker event the broker emits', () => {
        expect(mod.unwrap(mod.events.BROKER_API_VERSIONS)).toEqual(BROKER_API_VERSIONS)
      })

      test('wraps the raw broker event back into the namespaced alias', () => {
        expect(mod.wrap(BROKER_API_VERSIONS)).toEqual(mod.events.BROKER_API_VERSIONS)
      })
    })
  }
})

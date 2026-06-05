const InstrumentationEventType = require('../instrumentation/eventType')
const eventType = InstrumentationEventType('broker')

module.exports = {
  BROKER_API_VERSIONS: eventType('api_versions'),
}

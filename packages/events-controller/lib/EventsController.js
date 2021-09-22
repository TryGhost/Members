const EventsRepository = require('./EventsRepository');
/**
 * @template Data
 * @typedef {object} IEvent
 * @prop {Date} timestamp
 * @prop {Data} data
 */

class EventsController {
    static createEvents(req, res) {
        try {
            const {events} = req.body;
            for (const event of events) {
                EventsRepository.create(event);
            }
            res.writeHead(201);
            return res.end('Created.');
        } catch (err) {
            const statusCode = (err && err.statusCode) || 500;
            res.writeHead(statusCode);
            return res.end('Internal Server Error.');
        }
    }
}

module.exports = EventsController;

'use strict';

const log = require('../../src/lib/logger');

describe('logger', () => {
  afterEach(() => {
    delete process.env.LOG_IN_TESTS;
    jest.restoreAllMocks();
  });

  test('redacts card numbers', () => {
    expect(log.redact('paid with 4111 1111 1111 1111 ok')).toBe('paid with ****1111 ok');
    expect(log.redact('no pan here: 12345')).toBe('no pan here: 12345');
  });

  test('is silent during tests by default', () => {
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log.info('hello');
    expect(spy).not.toHaveBeenCalled();
  });

  test('writes redacted JSON lines when enabled', () => {
    process.env.LOG_IN_TESTS = '1';
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log.warn('card used', { card: '4111111111111111' });
    log.error('boom');
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line).toMatchObject({ level: 'warn', message: 'card used', card: '****1111' });
    expect(JSON.parse(spy.mock.calls[1][0]).level).toBe('error');
  });
});

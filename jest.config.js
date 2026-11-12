'use strict';

// No coverageThreshold here on purpose: the quality gate script decides
// whether a coverage value is a warning (70-80%) or critical (< 70%).
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit'],
  collectCoverageFrom: ['src/**/*.js', '!src/server.js'],
  coverageDirectory: 'reports/coverage',
  coverageReporters: ['text', 'lcov', 'json-summary', 'cobertura'],
  reporters: ['default', ['jest-junit', { outputDirectory: 'reports', outputName: 'junit-unit.xml' }]],
};

module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts', 'tsx'],
  testEnvironment: 'node',
  testRunner: 'jest-circus/runner',
  transform: {
    '^.+\\.ts$': 'babel-jest',
    '^.+\\.tsx$': 'babel-jest',
  },
  collectCoverage: true,
  projects: [],
  coverageReporters: ['text'],
  coverageThreshold: {
    global: {
      lines: 100,
    },
  },
  collectCoverageFrom: [
    '**/packages/automatic-releases/**/*.ts',
    '!**/dist/**',
    '!**/packages/automatic-releases/src/index.ts',
    '!**/packages/automatic-releases/src/uploadReleaseArtifacts.ts',
  ],
};

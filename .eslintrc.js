module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  extends: ['plugin:@typescript-eslint/recommended', 'prettier', 'plugin:prettier/recommended'],
  plugins: ['prettier'],
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
  rules: {
    '@typescript-eslint/explicit-function-return-type': 0,
    'prettier/prettier': [
      'error',
      {
        semi: true,
        trailingComma: 'all',
        bracketSpacing: false,
        singleQuote: true,
        printWidth: 120,
      },
    ],
  },
  reportUnusedDisableDirectives: true,
};

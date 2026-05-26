import { defineFunction } from '@aws-amplify/backend';

export const onUserSignUp = defineFunction({
  name: 'on-user-sign-up',
  entry: './handler.ts',
});
